import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  format: "cjs",
  platform: "node",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
  minify: false,
};

if (watch) {
  const ctx = await esbuild.context({
    ...options,
    plugins: [
      {
        name: "rebuild-notify",
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length > 0) {
              console.error(`[esbuild] build failed with ${result.errors.length} error(s)`);
            } else {
              console.log("[esbuild] build finished");
            }
          });
        },
      },
    ],
  });
  console.log("[esbuild] watching for changes...");
  await ctx.watch();
} else {
  await esbuild.build(options);
  console.log("Extension built successfully.");
}
