import { loadConfig, ConfigError } from './config.js';

async function main(): Promise<void> {
  try {
    const config = await loadConfig();
    process.stdout.write('Config loaded successfully:\n');
    process.stdout.write(`  Foundry endpoint:   ${config.foundry.endpoint}\n`);
    process.stdout.write(`  Foundry deployment: ${config.foundry.deployment}\n`);
    process.stdout.write(`  AMG endpoint:       ${config.amg.endpoint}\n`);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

void main();
