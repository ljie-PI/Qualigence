// Emits argv[3] on stdout then exits with the code in argv[2]. Used to verify
// the cli-process helper captures the exit code and standard output.
const code = Number(process.argv[2] ?? "0");
const message = process.argv[3];
if (message !== undefined) {
  process.stdout.write(`${message}\n`);
}
process.exit(code);
