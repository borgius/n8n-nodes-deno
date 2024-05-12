const path = require('path');
const { task, src, dest, series } = require('gulp');

task('build:icons', async () => {
	const nodeSource = path.resolve('nodes', '**', '*.{png,svg}');
	const nodeDestination = path.resolve('dist', 'nodes');

	await src(nodeSource).pipe(dest(nodeDestination));

	const credSource = path.resolve('credentials', '**', '*.{png,svg}');
	const credDestination = path.resolve('dist', 'credentials');

	return await src(credSource).pipe(dest(credDestination));
});

task('build:files', async () => {
	await src('{README.md,LICENSE.md}').pipe(dest('dist'));
});

task('default', series('build:icons', 'build:files'));
