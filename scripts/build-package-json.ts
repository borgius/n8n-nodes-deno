import { join } from 'node:path';
import packageJson from '../package.json';
import { writeFile } from 'node:fs/promises';

(async () => {
	const result: Partial<typeof packageJson> = packageJson;
	delete result.scripts;
	delete result.devDependencies;
	result.files = result?.files?.map((file) => {
		return file.replace('dist/', '');
	});
	result.n8n!.nodes = result?.n8n!.nodes?.map((file) => {
		return file.replace('dist/', '');
	});

	const resultPath = join(__dirname, '..', 'dist', 'package.json');
	console.log(`Write ${resultPath}`);
	await writeFile(resultPath, JSON.stringify(result, null, 2), 'utf-8');
})();
