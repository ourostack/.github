// process.exit() right after a large write to a pipe truncates it at the pipe buffer (64 KiB): the reader got half a JSON
// report and converge called it "no report". Exit only once everything written has been handed to the pipe.
export function exitAfterFlush(code) {
  process.stdout.write("", () => process.exit(code));
}
