// Node 24 treats an explicit directory argument as a module entry point.
// Keep `node --test test/host` portable without changing package.json.
// When Node discovers individual *.js files, avoid registering the suite twice.
if (!process.argv[1]?.endsWith('.js')) {
  for (const name of ['config', 'git', 'session-context', 'llm-json', 'store', 'guard', 'seat', 'errors']) {
    await import(`./${name}.test.js`);
  }
}
