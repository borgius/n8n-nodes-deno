import {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';
import { DenoWorker, DenoWorkerOptions } from 'deno-vm';
import { createHash } from 'crypto';

enum CodeExecutionMode {
	runOnceForAllItems = 'runOnceForAllItems',
	runOnceForEachItem = 'runOnceForEachItem',
}
const CodeExecutionModeDefault = CodeExecutionMode.runOnceForEachItem;

enum CodeProcessingMode {
	sequential = 'sequential',
	parallel = 'parallel',
}

let workerCommandIndex = 0;
const commands = new Map<typeof workerCommandIndex, any>();

function nextCommandIndex() {
	let next = workerCommandIndex;
	do {
		next++;
		if (next === Number.MAX_VALUE) {
			next = 0;
		}
	} while (commands.has(next));

	workerCommandIndex = next;
	return next;
}

function createWorker(denoTypeScriptCode: string, options: Partial<DenoWorkerOptions>) {
	const script = `
self.onmessage = async (e) => {
	const { uid, data } = e.data;
	const isRunOnceForAllItems = Array.isArray(data);
	const { item, items } = isRunOnceForAllItems ?
		{ items: data.map(d => ({json: d})), item: {json: data[0]} } :
		{ items: null, item: {json: data} };

	const $input = isRunOnceForAllItems ? {
		all: () => items,
		item
	} : {
		all: () => { throw new Error("Can't use .all() here") },
		item
	}
	const $json = item.json;
	const $ = () => { throw new Error("$(<NodeName>) Not yet implemented in Deno Code") };
	// TODO: Implement Built-in methods and variables: https://docs.n8n.io/code/builtin/overview/
	// const $execution
	// const $ifEmpty();
	// const $jmespath();
	// const $now;
	// const $prevNode;
	// const $runIndex;
	// const $today;
	// const $vars;
	// const $workflow;

	async function handler() {
		${denoTypeScriptCode}
	}

	let result, error;
	try {
		result = await handler();
	} catch(err) {
		error = err;
	}

	self.postMessage({
		uid,
		result,
		error
	});
};
`;
	const worker = new DenoWorker(script, options);

	worker.onmessage = (e) => {
		const { uid, result, error } = e.data;
		const command = commands.get(uid);
		commands.delete(uid);
		if (error) {
			command.reject(error);
		} else {
			command.resolve(result);
		}
	};
	worker.onexit = (code, signal) => {
		// Logger.info(`[${description.name}] Deno worker onexit, code: ${code}`);
	};

	return worker;
}

async function executeCommand(worker: DenoWorker, data: any) {
	const command = {
		uid: nextCommandIndex(),
		resolve: (_: any) => {},
		reject: (_: any) => {},
	};

	commands.set(command.uid, command);

	const promise = new Promise<any>((resolve, reject) => {
		command.resolve = resolve;
		command.reject = reject;
	});

	worker.postMessage({
		uid: command.uid,
		data,
	});

	return promise;
}

function hash(data: IDataObject) {
	return createHash('sha1').update(JSON.stringify(data)).digest('base64');
}

type NodeId = string;
interface WorkerInfo {
	worker: DenoWorker;
	scriptHash: string;
}

const workers = new Map<NodeId, WorkerInfo>();

function getWorker(nodeId: NodeId, script: string, options: Partial<DenoWorkerOptions>) {
	let info = workers.get(nodeId);
	// TODO: Use some fast hash function
	const scriptHash = hash({ script, options });
	// If script changed, need to exit worker
	if (info && info.scriptHash !== scriptHash) {
		info.worker.closeSocket();
		info = undefined;
		workers.delete(nodeId);
		// Logger.info(`[${description.name}] Deno worker dropped, node: ${nodeId}`);
	}
	if (!info) {
		info = {
			scriptHash,
			worker: createWorker(script, options),
		};
		workers.set(nodeId, info);
		// Logger.info(`[${description.name}] Deno worker created, node: ${nodeId}`);
	}

	return info.worker;
}

const modeProperty: INodeProperties = {
	displayName: 'Mode',
	name: 'mode',
	type: 'options',
	noDataExpression: true,
	options: [
		{
			name: 'Run Once for All Items',
			value: CodeExecutionMode.runOnceForAllItems,
			description: 'Run this code only once, no matter how many input items there are',
		},
		{
			name: 'Run Once for Each Item',
			value: CodeExecutionMode.runOnceForEachItem,
			description: 'Run this code as many times as there are input items',
		},
	],
	default: CodeExecutionModeDefault,
};

// eslint-disable-next-line n8n-nodes-base/node-param-default-missing
const processingProperty: INodeProperties = {
	displayName: 'Processing',
	name: 'processing',
	type: 'options',
	default: CodeProcessingMode.sequential,
	noDataExpression: true,
	options: [
		{
			name: 'Sequential',
			value: CodeProcessingMode.sequential,
			description:
				'Run this code sequentially for each item one by one. The total execution time will be the sum of the execution time of each item.',
		},
		{
			name: 'Parallel',
			value: CodeProcessingMode.parallel,
			description:
				'Run this code in parallel for all items at once. The total execution time will be less than the sum of the execution of each item.',
		},
	],
};

const tsCodeProperty: INodeProperties = {
	displayName: 'Deno TypeScript Code',
	name: 'tsCode',
	type: 'string',
	typeOptions: {
		// rows: 10,
		editor: 'codeNodeEditor',
		editorLanguage: 'javaScript',
		alwaysOpenEditWindow: true,
	},
	noDataExpression: true,
	default: '',
	placeholder: 'Deno code',
	description:
		'<a href="https://www.typescriptlang.org/">TypeScript</a> code running in <a href="https://deno.com/">Deno</a> runtime',
};

const permissionsProperty: INodeProperties = {
	displayName: 'Permissions',
	name: 'permissions',
	type: 'fixedCollection',
	typeOptions: {
		multipleValues: true,
	},
	placeholder: 'Select Permissions',
	default: {},
	description:
		'Deno <a href="https://docs.deno.com/runtime/manual/basics/permissions">permissions</a> options',
	options: [
		{
			displayName: 'Values',
			name: 'values',
			values: [
				{
					displayName: 'Permission',
					name: 'name',
					type: 'options',
					description: 'Select permission from the list',
					// default: 'allowNet',
					default: 'allowAll',
					placeholder: '',
					options: [
						{
							name: 'Allow All',
							value: 'allowAll',
							description: 'Whether to allow all permissions',
						},
						{
							name: 'Allow Env',
							value: 'allowEnv',
							description: 'Whether to allow reading environment variables',
						},
						{
							name: 'Allow Hrtime',
							value: 'allowHrtime',
							description: 'Whether to allow high resolution time measurement',
						},
						{
							name: 'Allow Net',
							value: 'allowNet',
							description:
								'Whether to allow network connections. Including for &lt;pre&gt;await import("https://...")&lt;/pre&gt;.',
						},
						{
							name: 'Allow Read',
							value: 'allowRead',
							description: 'Whether to allow reading from the filesystem',
						},
						{
							name: 'Allow Run',
							value: 'allowRun',
							description: 'Whether to allow running subprocesses',
						},
						{
							name: 'Allow Write',
							value: 'allowWrite',
							description: 'Whether to allow writing to the filesystem',
						},
					],
				},
			],
		},
	],
};

type DenoWorkerOptionsPermissions = DenoWorkerOptions['permissions'];

function createPermissions(parameters: IDataObject): DenoWorkerOptionsPermissions {
	const values = parameters.values as IDataObject[];
	if (!Array.isArray(values)) {
		return {};
	}

	return values.reduce((result, param) => {
		const name = param['name'] as string;
		result[name] = true;
		return result;
	}, {} as any);
}

const description: INodeTypeDescription = {
	displayName: 'Deno Code',
	name: 'denoCode',
	icon: 'file:deno.svg',
	group: ['transform'],
	version: 1,
	description: 'Run custom TypeScript code in Deno runtime',
	defaults: {
		name: 'Deno',
	},
	inputs: ['main'],
	outputs: ['main'],
	parameterPane: 'wide',
	properties: [modeProperty, processingProperty, tsCodeProperty, permissionsProperty],
};

export class DenoCode implements INodeType {
	description = description;

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		// const workflowMode = this.getMode();
		const nodeMode = this.getNodeParameter(modeProperty.name, 0) as CodeExecutionMode;
		const processing = this.getNodeParameter(processingProperty.name, 0);
		const tsCode = this.getNodeParameter(tsCodeProperty.name, 0, '') as string;
		const permissionsParams = this.getNodeParameter(permissionsProperty.name, 0, '') as IDataObject;
		const permissions = createPermissions(permissionsParams);
		const node = this.getNode();
		const worker = getWorker(node.id, tsCode, { permissions });

		const items = this.getInputData();
		const executionData: INodeExecutionData[] = [];

		if (nodeMode === CodeExecutionMode.runOnceForEachItem) {
			const runOnceForEachItem = async (
				item: INodeExecutionData,
				itemIndex: number,
			): Promise<INodeExecutionData> => {
				const data = item?.json;

				try {
					const result = await executeCommand(worker!, data);
					return {
						json: result,
						pairedItem: itemIndex,
					};
				} catch (error) {
					if (this.continueOnFail()) {
						return { json: data, error, pairedItem: itemIndex };
					}
					if (error.context) {
						error.context.itemIndex = itemIndex;
						throw error;
					}
					throw new NodeOperationError(this.getNode(), error, {
						itemIndex,
					});
				}
			};

			if (processing === CodeProcessingMode.sequential) {
				for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
					const item = items[itemIndex];
					const result = await runOnceForEachItem(item, itemIndex);
					executionData.push(result);
				}
			} else if (processing === CodeProcessingMode.parallel) {
				const results = await Promise.all(items.map(runOnceForEachItem));
				executionData.push(...results);
			} else {
				throw new NodeOperationError(
					node,
					`Unknown "${processingProperty.displayName}" property value: ${processing}`,
				);
			}
		} else if (nodeMode === CodeExecutionMode.runOnceForAllItems) {
			const runOnceForAllItems = async (): Promise<INodeExecutionData[]> => {
				try {
					const data = items.map((item) => item.json);
					const result = await executeCommand(worker!, data);
					return this.helpers.returnJsonArray(result);
				} catch (error) {
					const nodeError = new NodeOperationError(node, error);
					if (this.continueOnFail()) {
						return this.helpers.returnJsonArray({ json: { error: nodeError } });
					}
					throw nodeError;
				}
			};
			executionData.push(...(await runOnceForAllItems()));
		} else {
			throw new NodeOperationError(
				node,
				`Unknown "${modeProperty.displayName}" property value: ${nodeMode}`,
			);
		}

		return this.prepareOutputData(executionData);
	}
}
