async function main(): Promise<void> {
  // The pure benchmark imports shared schema services whose DB-backed functions
  // are not called here, but appDb still validates this environment variable at
  // module load. Use an inert value so the standalone benchmark needs no DB.
  process.env.DATABASE_URL ||= "postgresql://benchmark:benchmark@127.0.0.1:1/unused";
  const { runLargeSchemaBenchmark } = await import("./largeSchemaBenchmark");
  const result = await runLargeSchemaBenchmark();
  console.log(JSON.stringify(result, null, 2));
  if (!result.release_gates.all_passed) {
    process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  const error = err as { stack?: string; message?: string };
  console.error(error.stack || error.message || String(err));
  process.exit(1);
});
