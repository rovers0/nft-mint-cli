import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import path from "node:path";

/*
 * ============================================================
 * CONFIG-BASED MINT RUNNER
 * ============================================================
 *
 * PURPOSE
 * -------
 * Shorten the mint command by reading params from a JSON config
 * file instead of typing them by hand every time. Useful when you
 * mint many different collections — each gets its own file, e.g.:
 *
 *   robominttest.config.json
 *   othercollection.config.json
 *
 * placed at the project root, next to package.json.
 *
 * IMPORTANT — SAFETY:
 * - Does NOT import cli.ts, mint-engine.ts or broadcast.ts.
 * - Does NOT change how the mint flow runs in any way.
 * - It only builds a normal argv array and spawns the EXACT
 *   same command you would type yourself:
 *
 *     npx tsx src/cli.ts --slug ... --chain-id ... --wallet ...
 *
 *   as a child process. cli.ts runs completely untouched.
 * ============================================================
 */

interface MintConfig {
  slug?: string;
  chainId?: number | string;
  wallet?: string;
  quantity?: number | string;
  gasLimit?: number | string;
  confirm?: boolean;
}

const REQUIRED_FIELDS = ["slug", "chainId", "wallet"] as const;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const cliPath = path.join(projectRoot, "src", "cli.ts");

function printHelp(): void {
  console.log(`
Config-based mint runner
(does not modify cli.ts / mint-engine.ts / broadcast.ts in any way)

Usage:
  npx tsx src/mint-preset.ts <collectionName|path/to/file.json> [overrides...]

A bare name (no slash, no .json) is looked up as:
  <projectRoot>/<name>.config.json

Examples:
  npx tsx src/mint-preset.ts robominttest
    -> loads ./robominttest.config.json (next to package.json)

  npx tsx src/mint-preset.ts robominttest --quantity 2
  npx tsx src/mint-preset.ts other-collection.config.json --no-confirm

Config file (JSON), e.g. robominttest.config.json (project root):

  {
    "slug": "robominttest",
    "chainId": 4663,
    "wallet": "0x0CbA5D0cd0c6a7e8581A4e57684B069a8C024F16",
    "quantity": 1,
    "gasLimit": 180000,
    "confirm": true
  }

Any flag passed after the collection name overrides that field for this
run only — the config file itself is never modified.

Supported override flags:
  --slug --chain-id --wallet --quantity --gas-limit --confirm --no-confirm
`);
}

function resolveConfigPath(nameOrPath: string): string {
  const looksLikePath =
    nameOrPath.endsWith(".json") || nameOrPath.includes("/") || nameOrPath.includes("\\");

  if (looksLikePath) {
    return path.isAbsolute(nameOrPath) ? nameOrPath : path.join(projectRoot, nameOrPath);
  }

  return path.join(projectRoot, `${nameOrPath}.config.json`);
}

function loadConfig(filePath: string): MintConfig {
  if (!existsSync(filePath)) {
    throw new Error(
      `Config file not found: ${filePath}\n` +
        `Create it (see --help for the format), or pass an existing collection name.`,
    );
  }

  const raw = readFileSync(filePath, "utf8");

  try {
    return JSON.parse(raw) as MintConfig;
  } catch (error) {
    throw new Error(`Config file is not valid JSON: ${filePath}\n${String(error)}`);
  }
}

function applyOverrides(config: MintConfig, overrideArgs: string[]): MintConfig {
  const merged: MintConfig = { ...config };

  for (let i = 0; i < overrideArgs.length; i++) {
    const arg = overrideArgs[i];

    switch (arg) {
      case "--slug":
        merged.slug = overrideArgs[++i];
        break;
      case "--chain-id":
        merged.chainId = overrideArgs[++i];
        break;
      case "--wallet":
        merged.wallet = overrideArgs[++i];
        break;
      case "--quantity":
        merged.quantity = overrideArgs[++i];
        break;
      case "--gas-limit":
        merged.gasLimit = overrideArgs[++i];
        break;
      case "--confirm":
        merged.confirm = true;
        break;
      case "--no-confirm":
        merged.confirm = false;
        break;
      default:
        throw new Error(`Unknown override flag: ${arg} (see --help)`);
    }
  }

  return merged;
}

function buildCliArgs(config: MintConfig, configLabel: string): string[] {
  const missing = REQUIRED_FIELDS.filter((key) => config[key] === undefined || config[key] === "");

  if (missing.length > 0) {
    throw new Error(`Config "${configLabel}" is missing required field(s): ${missing.join(", ")}`);
  }

  const args: string[] = [
    "--slug",
    String(config.slug),
    "--chain-id",
    String(config.chainId),
    "--wallet",
    String(config.wallet),
  ];

  if (config.quantity !== undefined) args.push("--quantity", String(config.quantity));
  if (config.gasLimit !== undefined) args.push("--gas-limit", String(config.gasLimit));
  if (config.confirm) args.push("--confirm");

  return args;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }

  const [configArg, ...overrideArgs] = args;
  const configPath = resolveConfigPath(configArg);
  const config = applyOverrides(loadConfig(configPath), overrideArgs);
  const cliArgs = buildCliArgs(config, configArg);

  console.log(`[CONFIG] Loaded: ${configPath}`);
  console.log(`[CONFIG] Running: npx tsx src/cli.ts ${cliArgs.join(" ")}`);
  console.log("");

  await new Promise<void>((resolve, reject) => {
    // shell: true so `npx` resolves correctly on Windows (npx.cmd) too.
    const child = spawn("npx", ["tsx", cliPath, ...cliArgs], {
      cwd: projectRoot,
      stdio: "inherit",
      shell: true,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

main().catch((error: unknown) => {
  console.error("");
  console.error("[ERROR]", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});