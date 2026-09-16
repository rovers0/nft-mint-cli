import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import path from "node:path";

/*
 * ============================================================
 * CONFIG-BASED GAS ESTIMATE RUNNER
 * ============================================================
 *
 * PURPOSE
 * -------
 * Same idea as mint-preset.ts, but for the gas pre-estimate tool.
 * Reuses the SAME <name>.config.json file you already have for
 * minting — no need for a second config file per collection.
 *
 * IMPORTANT — SAFETY:
 * - Does NOT import cli.ts, mint-engine.ts, broadcast.ts, or
 *   modify src/tools/gas-preestimate.ts in any way.
 * - It only builds a normal argv array and spawns the EXACT
 *   same command you would type yourself:
 *
 *     npx tsx src/tools/gas-preestimate.ts --slug ... --chain-id ...
 *
 *   as a child process.
 * ============================================================
 */

interface MintConfig {
  slug?: string;
  chainId?: number | string;
  wallet?: string;
  quantity?: number | string;
  // Ignored by this tool, only relevant to mint-preset.ts:
  gasLimit?: number | string;
  confirm?: boolean;
  // Optional, only relevant to gas-preestimate.ts:
  safety?: number | string;
  round?: number | string;
}

const REQUIRED_FIELDS = ["slug", "chainId", "wallet"] as const;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const toolPath = path.join(projectRoot, "src", "tools", "gas-preestimate.ts");

function printHelp(): void {
  console.log(`
Config-based gas estimate runner
(does not modify gas-preestimate.ts / cli.ts / mint-engine.ts in any way)

Usage:
  npx tsx src/gas-preset.ts <collectionName|path/to/file.json> [overrides...]

Reuses the SAME config file as mint-preset.ts, e.g. robominttest.config.json
(project root, next to package.json):

  {
    "slug": "robominttest",
    "chainId": 4663,
    "wallet": "0x0CbA5D0cd0c6a7e8581A4e57684B069a8C024F16",
    "quantity": 1
  }

Examples:
  npx tsx src/gas-preset.ts robominttest
  npx tsx src/gas-preset.ts robominttest --safety 60 --round 5000

Supported override flags:
  --slug --chain-id --wallet --quantity --safety --round
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
      case "--safety":
        merged.safety = overrideArgs[++i];
        break;
      case "--round":
        merged.round = overrideArgs[++i];
        break;
      default:
        throw new Error(`Unknown override flag: ${arg} (see --help)`);
    }
  }

  return merged;
}

function buildToolArgs(config: MintConfig, configLabel: string): string[] {
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
  if (config.safety !== undefined) args.push("--safety", String(config.safety));
  if (config.round !== undefined) args.push("--round", String(config.round));

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
  const toolArgs = buildToolArgs(config, configArg);

  console.log(`[CONFIG] Loaded: ${configPath}`);
  console.log(`[CONFIG] Running: npx tsx src/tools/gas-preestimate.ts ${toolArgs.join(" ")}`);
  console.log("");

  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["tsx", toolPath, ...toolArgs], {
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