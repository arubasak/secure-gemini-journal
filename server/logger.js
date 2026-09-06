// Structured JSON logging. Cloud Run's log agent parses the `severity` field
// so entries are filterable by level in Cloud Logging.
function emit(severity, message, fields = {}) {
  const line = JSON.stringify({ severity, message, time: new Date().toISOString(), ...fields });
  if (severity === 'ERROR' || severity === 'CRITICAL') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (m, f) => process.env.LOG_LEVEL === 'debug' && emit('DEBUG', m, f),
  info: (m, f) => emit('INFO', m, f),
  warn: (m, f) => emit('WARNING', m, f),
  error: (m, f) => emit('ERROR', m, f),
};
