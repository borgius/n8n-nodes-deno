import {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';
import { DenoWorker, DenoWorkerOptions } from '@chudnyi/deno-vm';
import { createHash } from 'crypto';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

enum CodeExecutionMode {
	runOnceForAllItems = 'runOnceForAllItems',
	runOnceForEachItem = 'runOnceForEachItem',
}
const CodeExecutionModeDefault = CodeExecutionMode.runOnceForEachItem;

enum CodeProcessingMode {
	sequential = 'sequential',
	parallel = 'parallel',
}

interface ICommand {
	uid: number;
	resolve: (_: any) => any;
	reject: (_: any) => any;
}

class DenoCodeWorker extends DenoWorker {
	private workerCommandIndex = 0;
	private commands = new Map<number, ICommand>();

	constructor(script: string | URL, options: Partial<DenoWorkerOptions>) {
		super(script, options);

		this.onmessage = (e) => {
			const { uid, result, error } = e.data;
			const command = this.commands.get(uid);
			this.commands.delete(uid);
			if (error) {
				command?.reject(error);
			} else {
				command?.resolve(result);
			}
		};
		// TODO: Write log
		this.onexit = (code, signal) => {
			// console.log(`[${description.name}] Deno worker onexit, code: ${code}`);
			// Reject all awaiting commands
			this.commands.forEach((command, uid) => {
				command.reject(
					new Error(`Deno worker terminated or failed to start, code: ${code}, signal: ${signal}`),
				);
			});
			this.commands.clear();
		};

	}

	private nextCommandIndex() {
		let next = this.workerCommandIndex;
		do {
			next++;
			if (next === Number.MAX_VALUE) {
				next = 0;
			}
		} while (this.commands.has(next));

		this.workerCommandIndex = next;
		return next;
	}

	public async  executeCommand(data: any) {
		const command: ICommand = {
			uid: this.nextCommandIndex(),
			resolve: (_: any) => {},
			reject: (_: any) => {},
		};

		this.commands.set(command.uid, command);

		const promise = new Promise<any>((resolve, reject) => {
			command.resolve = resolve;
			command.reject = reject;
		});

		this.postMessage({
			uid: command.uid,
			data,
		});

		return promise;
	}
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

	let denoPath = require.resolve('deno-bin/package.json');
	denoPath = join(denoPath, '..', 'bin', 'deno');
	// console.log(`[${description.name}] Use Deno executable: ${denoPath}`);
	if(!existsSync(denoPath)) {
		// eslint-disable-next-line n8n-nodes-base/node-execute-block-wrong-error-thrown
		throw new Error(`Not found Deno executable by path: ${denoPath}`)
	}

	return new DenoCodeWorker(script, {
		...options,
		denoExecutable: denoPath,
	});
}


function hash(data: IDataObject) {
	return createHash('sha1').update(JSON.stringify(data)).digest('base64');
}

type NodeId = string;
interface WorkerInfo {
	worker: DenoCodeWorker;
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
		// TODO: Write log
		// Logger.info(`[${description.name}] Deno worker dropped, node: ${nodeId}`);
	}
	if (!info) {
		info = {
			scriptHash,
			worker: createWorker(script, options),
		};
		workers.set(nodeId, info);
		// TODO: Write log
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
					default: 'allowAll',
					placeholder: '',
					noDataExpression: true,
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
		const node = this.getNode();
		const nodeMode = this.getNodeParameter(modeProperty.name, 0) as CodeExecutionMode;
		const processing = this.getNodeParameter(processingProperty.name, 0);
		const tsCode = this.getNodeParameter(tsCodeProperty.name, 0, '') as string;
		const permissionsParams = this.getNodeParameter(permissionsProperty.name, 0, '') as IDataObject;
		const permissions = createPermissions(permissionsParams);
		const inputItems = this.getInputData();
		const resultItems: INodeExecutionData[] = [];

		let worker: DenoCodeWorker;
		try {
			try {
				worker = getWorker(node.id, tsCode, { permissions });
			} catch (error) {
				throw new NodeOperationError(node, `Failed to create Deno worker: ${error.message}`);
			}

			// runOnceForEachItem
			if (nodeMode === CodeExecutionMode.runOnceForEachItem) {
				const runOnceForEachItem = async (
					item: INodeExecutionData,
					itemIndex: number,
				): Promise<INodeExecutionData> => {
					const data = item?.json;

					try {
						const result = await worker?.executeCommand(data);
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
						throw new NodeOperationError(node, error, {
							itemIndex,
						});
					}
				};

				// Sequential
				if (processing === CodeProcessingMode.sequential) {
					for (let itemIndex = 0; itemIndex < inputItems.length; itemIndex++) {
						const item = inputItems[itemIndex];
						const result = await runOnceForEachItem(item, itemIndex);
						resultItems.push(result);
					}
				}
				// Parallel
				else if (processing === CodeProcessingMode.parallel) {
					const results = await Promise.all(inputItems.map(runOnceForEachItem));
					resultItems.push(...results);
				}
				// Unknown
				else {
					throw new NodeOperationError(
						node,
						`Unknown "${processingProperty.displayName}" property value: ${processing}`,
					);
				}
			}
			// runOnceForAllItems
			else if (nodeMode === CodeExecutionMode.runOnceForAllItems) {
				const runOnceForAllItems = async (): Promise<INodeExecutionData[]> => {
					try {
						const data = inputItems.map((item) => item.json);
						const result = await worker!.executeCommand(data);
						return this.helpers.returnJsonArray(result);
					} catch (error) {
						const nodeError = new NodeOperationError(node, error);
						if (this.continueOnFail()) {
							return this.helpers.returnJsonArray({ json: { error: nodeError } });
						}
						throw nodeError;
					}
				};
				resultItems.push(...(await runOnceForAllItems()));
			}
			// Unknown
			else {
				throw new NodeOperationError(
					node,
					`Unknown "${modeProperty.displayName}" property value: ${nodeMode}`,
				);
			}
		} catch (error) {
			if (this.continueOnFail()) {
				resultItems.push(...this.helpers.returnJsonArray({ json: { error } }));
			} else {
				throw error;
			}
		}

		return this.prepareOutputData(resultItems);
	}
}
