const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

// The config shipped with the code: used in place when CONFIG_PATH is not set (the Docker layout), and as
// the template for a config file that does not exist yet.
const BUNDLED_CONFIG_PATH = path.resolve(__dirname, '..', 'config', 'config.json');
const SCHEMA_PATH = path.resolve(__dirname, '..', 'config', 'schema.json');

const ajv = new Ajv({ allErrors: true, useDefaults: true });
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const validate = ajv.compile(schema);

/** Throws when `cfg` does not match the schema; fills in schema defaults otherwise. */
function validateConfig(cfg) {
  if (!validate(cfg)) {
    const err = new Error('Invalid config: ' + ajv.errorsText(validate.errors));
    err.details = validate.errors;
    throw err;
  }
  return cfg;
}

function resolveConfigPath(env = process.env) {
  const given = (env.CONFIG_PATH || '').trim();
  return given ? path.resolve(given) : BUNDLED_CONFIG_PATH;
}

function readConfigFile(file) {
  return validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** Written to a temporary file and renamed, so a reader never sees half a config. */
function writeConfigFile(file, cfg) {
  validateConfig(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * The config as the running server sees it. `get()` re-reads the file when it changed on disk (another
 * process, such as the macOS app, may rewrite it at any time); an invalid new file keeps the last good
 * config in use and is reported by `status()`.
 */
function createConfigStore({ file = resolveConfigPath(), checkIntervalMs = 1000, log = console } = {}) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(BUNDLED_CONFIG_PATH, file);
    log.log(`Created default config at ${file}`);
  }

  const stamp = () => {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  };

  let current = readConfigFile(file); // a broken config at startup is fatal: there is nothing to fall back on
  let seen = stamp();
  let lastCheck = Date.now();
  let lastError = null;
  let loadedAt = new Date();

  function reloadIfChanged(force = false) {
    const now = Date.now();
    if (!force && now - lastCheck < checkIntervalMs) return;
    lastCheck = now;
    let s;
    try {
      s = stamp();
    } catch (err) {
      lastError = `Config file unreadable: ${err.message}`;
      return;
    }
    if (s === seen) return;
    seen = s;
    try {
      current = readConfigFile(file);
      loadedAt = new Date();
      lastError = null;
      log.log(`Config reloaded from ${file}`);
    } catch (err) {
      lastError = err.message;
      log.error(`Config at ${file} changed but is not usable, keeping the previous one: ${err.message}`);
    }
  }

  return {
    file,
    get() {
      reloadIfChanged();
      return current;
    },
    save(cfg) {
      writeConfigFile(file, cfg);
      current = cfg;
      seen = stamp();
      loadedAt = new Date();
      lastError = null;
      return current;
    },
    status() {
      reloadIfChanged();
      return { file, loadedAt: loadedAt.toISOString(), error: lastError };
    },
  };
}

module.exports = {
  createConfigStore,
  resolveConfigPath,
  validateConfig,
  readConfigFile,
  writeConfigFile,
  BUNDLED_CONFIG_PATH,
  SCHEMA_PATH,
};
