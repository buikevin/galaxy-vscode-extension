const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

const treeSitterAssets = [
	['web-tree-sitter/tree-sitter.wasm', 'tree-sitter.wasm'],
	['tree-sitter-wasms/out/tree-sitter-python.wasm', 'tree-sitter-python.wasm'],
	['tree-sitter-wasms/out/tree-sitter-go.wasm', 'tree-sitter-go.wasm'],
	['tree-sitter-wasms/out/tree-sitter-rust.wasm', 'tree-sitter-rust.wasm'],
	['tree-sitter-wasms/out/tree-sitter-java.wasm', 'tree-sitter-java.wasm'],
];

function copyRuntimeAssets() {
	const outDir = path.join(__dirname, 'dist', 'wasm');
	fs.mkdirSync(outDir, { recursive: true });

	for (const [sourceModulePath, targetFileName] of treeSitterAssets) {
		const sourcePath = require.resolve(sourceModulePath);
		const targetPath = path.join(outDir, targetFileName);
		fs.copyFileSync(sourcePath, targetPath);
	}
}

async function main() {
	const ctx = await esbuild.context({
		entryPoints: ['src/extension.ts'],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outdir: 'dist',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});

	if (watch) {
		await ctx.watch();
		return;
	}

	await ctx.rebuild();
	await ctx.dispose();
	copyRuntimeAssets();
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
