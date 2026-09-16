import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/*
 * ============================================================
 * NFT MINT GAS PRE-ESTIMATE TOOL
 * ============================================================
 *
 * PURPOSE
 * -------
 * Standalone pre-flight utility.
 *
 * IMPORTANT:
 * - Does NOT import mint-engine.ts
 * - Does NOT modify the existing mint flow
 * - Does NOT sign transactions
 * - Does NOT broadcast transactions
 * - Only builds mint calldata and estimates gas
 *
 * FLOW
 * ----
 *
 *   OpenSea drop
 *        |
 *        v
 *   Find ACTIVE phase
 *        |
 *        v
 *   OpenSea /mint
 *        |
 *        v
 *   Exact calldata
 *        |
 *        v
 *   estimateGas() on ALL RPCs
 *        |
 *        v
 *   Highest successful estimate
 *        |
 *        v
 *   +50% safety margin
 *        |
 *        v
 *   Round to nearest 1,000
 *        |
 *        v
 *   Recommended --gas-limit
 *
 * ============================================================
 */

import {
  type Address,
  type Chain,
  type PublicClient,
  createPublicClient,
  http,
} from "viem";

import { config } from "../config.js";
import { OpenSeaClient, type MintStage } from "../opensea.js";
import { resolveChain } from "../chains.js";

/*
 * ============================================================
 * CLI TYPES
 * ============================================================
 */

interface CliOptions {
  slug?: string;
  chainId?: string;
  wallet?: string;
  quantity?: string;
  safety?: string;
  round?: string;
}

/*
 * ============================================================
 * CONSTANTS
 * ============================================================
 */

const DEFAULT_QUANTITY = 1;

/**
 * Default safety margin:
 *
 * estimatedGas * 150 / 100
 *
 * Example:
 *
 * 91,318
 *    ↓
 * 136,977
 */
const DEFAULT_SAFETY_PERCENT = 50;

/**
 * Round the final recommended gas limit upward.
 *
 * 136,977 -> 137,000
 */
const DEFAULT_ROUND_TO = 1_000n;

/**
 * RPC timeout should be relatively aggressive because this is
 * a pre-flight tool. A slow RPC should not block all others.
 */
const RPC_TIMEOUT_MS = 8_000;

/**
 * We intentionally keep retries low.
 *
 * This tool is about getting a fast estimate, not guaranteed
 * RPC reliability.
 */
const RPC_RETRY_COUNT = 1;
const RPC_RETRY_DELAY_MS = 150;

/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

function elapsed(startedAt: number): string {
  return `${Math.round(performance.now() - startedAt)}ms`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value: string, name: string): number {
  const n = Number(value);

  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return n;
}

function parseNonNegativeInt(value: string, name: string): number {
  const n = Number(value);

  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return n;
}

function normalizeAddress(value: string, name: string): Address {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error(`${name} is not a valid EVM address: ${value}`);
  }

  return value as Address;
}

function roundUp(value: bigint, unit: bigint): bigint {
  if (unit <= 0n) {
    return value;
  }

  return ((value + unit - 1n) / unit) * unit;
}

function applySafetyMargin(
  estimatedGas: bigint,
  safetyPercent: number,
): bigint {
  return (
    estimatedGas *
    BigInt(100 + safetyPercent)
  ) / 100n;
}

function formatDate(unixSeconds?: number): string {
  if (typeof unixSeconds !== "number") {
    return "unknown";
  }

  return new Date(unixSeconds * 1000).toLocaleString();
}

function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/*
 * ============================================================
 * PHASE HELPERS
 * ============================================================
 */

function isActive(stage: MintStage, nowSec: number): boolean {
  if (typeof stage.startTime !== "number") {
    return false;
  }

  if (stage.startTime > nowSec) {
    return false;
  }

  if (
    typeof stage.endTime === "number" &&
    stage.endTime <= nowSec
  ) {
    return false;
  }

  return true;
}

function isFuture(stage: MintStage, nowSec: number): boolean {
  return (
    typeof stage.startTime === "number" &&
    stage.startTime > nowSec
  );
}

function isExpired(stage: MintStage, nowSec: number): boolean {
  return (
    typeof stage.endTime === "number" &&
    stage.endTime <= nowSec
  );
}

function stageKey(stage: MintStage): string {
  return [
    stage.label,
    stage.startTime ?? "",
    stage.endTime ?? "",
  ].join("|");
}

/*
 * ============================================================
 * RPC CLIENTS
 * ============================================================
 */

function createClients(
  chain: Chain,
  rpcUrls: string[],
): PublicClient[] {
  return rpcUrls.map((url) =>
    createPublicClient({
      chain,
      transport: http(url, {
        timeout: RPC_TIMEOUT_MS,
        retryCount: RPC_RETRY_COUNT,
        retryDelay: RPC_RETRY_DELAY_MS,
      }),
    }),
  );
}

/*
 * ============================================================
 * RPC ERROR FORMAT
 * ============================================================
 */

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/*
 * ============================================================
 * GAS ESTIMATE RESULT
 * ============================================================
 */

interface GasEstimateResult {
  rpcUrl: string;
  gas: bigint;
  latencyMs: number;
}

/*
 * ============================================================
 * ESTIMATE GAS ON ALL RPCS
 * ============================================================
 *
 * We do NOT use Promise.any() here.
 *
 * For gas estimation, safety is more important than finding the
 * fastest RPC.
 *
 * If:
 *
 * RPC 1 -> 91,318
 * RPC 2 -> 93,102
 *
 * we use:
 *
 * 93,102
 *
 * then add +50%.
 *
 * This is intentionally different from broadcastRace().
 * ============================================================
 */

async function estimateGasAcrossRpc(
  clients: PublicClient[],
  rpcUrls: string[],
  wallet: Address,
  to: Address,
  data: `0x${string}`,
  value: bigint,
): Promise<GasEstimateResult[]> {
  const startedAt = performance.now();

  const attempts = clients.map(async (client, index) => {
    const rpcStartedAt = performance.now();

    try {
      const gas = await client.estimateGas({
        account: wallet,
        to,
        data,
        value,
      });

      return {
        rpcUrl: rpcUrls[index],
        gas,
        latencyMs: Math.round(
          performance.now() - rpcStartedAt,
        ),
      } satisfies GasEstimateResult;
    } catch (error) {
      throw new Error(
        `[${rpcUrls[index]}] ${errorMessage(error)}`,
      );
    }
  });

  const settled = await Promise.allSettled(attempts);

  const successful: GasEstimateResult[] = [];

  const failures: string[] = [];

  for (const result of settled) {
    if (result.status === "fulfilled") {
      successful.push(result.value);
    } else {
      failures.push(errorMessage(result.reason));
    }
  }

  if (successful.length === 0) {
    throw new Error(
      [
        "All RPC estimateGas calls failed.",
        ...failures,
      ].join("\n"),
    );
  }

  successful.sort((a, b) => {
    if (a.gas < b.gas) return -1;
    if (a.gas > b.gas) return 1;
    return 0;
  });

  console.log(
    `[GAS] ${successful.length}/${rpcUrls.length} RPC(s) succeeded ` +
      `(${Math.round(performance.now() - startedAt)}ms)`,
  );

  for (const result of successful) {
    console.log(
      `[GAS] ${result.gas} @ ${result.rpcUrl} ` +
        `(${result.latencyMs}ms)`,
    );
  }

  for (const failure of failures) {
    console.log(`[GAS] RPC failed: ${failure}`);
  }

  return successful;
}


/*
 * ============================================================
 * SAFE HISTORICAL FALLBACK
 * ============================================================
 *
 * If OpenSea /mint returns 422 because THIS wallet is not
 * eligible for the active phase, we must NOT build/sign/broadcast
 * a transaction for this wallet.
 *
 * Instead, optionally estimate from historical successful mint
 * transactions supplied in:
 *
 *   <projectRoot>/gas-reference.json
 *
 * Example:
 * {
 *   "robominttest": {
 *     "transactions": [
 *       {
 *         "hash": "0x...",
 *         "gasUsed": 86225
 *       }
 *     ]
 *   }
 * }
 *
 * If only hashes are supplied, the tool fetches the receipt from
 * each configured RPC and uses gasUsed as a historical reference.
 *
 * This fallback NEVER signs or broadcasts anything.
 * It does NOT claim that historical gasUsed is an exact estimate.
 * ============================================================
 */

interface HistoricalReference {
  hash?: string;
  gasUsed?: number | string;
}

interface HistoricalConfig {
  [slug: string]: {
    transactions?: HistoricalReference[];
  };
}

interface HistoricalGasResult {
  hash: string;
  gasUsed: bigint;
  rpcUrl: string;
}

const HISTORICAL_CONFIG_NAME = "gas-reference.json";

function loadHistoricalReferences(slug: string): HistoricalReference[] {
  const filePath = path.join(process.cwd(), HISTORICAL_CONFIG_NAME);

  try {
    if (!existsSync(filePath)) {
      return [];
    }

    const raw = readFileSync(filePath, "utf8");
    const config = JSON.parse(raw) as HistoricalConfig;
    return config[slug]?.transactions ?? [];
  } catch (error) {
    console.log(
      `[FALLBACK] Could not read ${HISTORICAL_CONFIG_NAME}: ${errorMessage(error)}`,
    );
    return [];
  }
}

function normalizeTxHash(value: string): `0x${string}` {
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(`Invalid transaction hash: ${value}`);
  }

  return value as `0x${string}`;
}

async function estimateHistoricalGas(
  clients: PublicClient[],
  rpcUrls: string[],
  references: HistoricalReference[],
): Promise<HistoricalGasResult[]> {
  const results: HistoricalGasResult[] = [];

  for (const reference of references) {
    try {
      let suppliedGas: bigint | undefined;

      if (reference.gasUsed !== undefined) {
        const value = BigInt(reference.gasUsed);

        if (value > 0n) {
          suppliedGas = value;
        }
      }

      if (reference.hash) {
        const hash = normalizeTxHash(reference.hash);

        const attempts = await Promise.allSettled(
          clients.map(async (client, index) => {
            const receipt = await client.getTransactionReceipt({
              hash,
            });

            if (receipt.status !== "success") {
              throw new Error(
                `transaction status is ${receipt.status}`,
              );
            }

            return {
              hash,
              gasUsed: receipt.gasUsed,
              rpcUrl: rpcUrls[index],
            } satisfies HistoricalGasResult;
          }),
        );

        for (const attempt of attempts) {
          if (attempt.status === "fulfilled") {
            results.push(attempt.value);
            break;
          }
        }

        if (results.some((item) => item.hash === hash)) {
          continue;
        }
      }

      if (suppliedGas !== undefined) {
        results.push({
          hash: reference.hash ?? "manual-reference",
          gasUsed: suppliedGas,
          rpcUrl: "gas-reference.json",
        });
      }
    } catch (error) {
      console.log(
        `[FALLBACK] Reference failed: ${errorMessage(error)}`,
      );
    }
  }

  return results;
}

function calculateHistoricalRecommendation(
  results: HistoricalGasResult[],
  safetyPercent: number,
  roundTo: bigint,
): {
  maxGas: bigint;
  averageGas: bigint;
  recommendedGas: bigint;
} {
  let maxGas = 0n;
  let totalGas = 0n;

  for (const result of results) {
    if (result.gasUsed > maxGas) {
      maxGas = result.gasUsed;
    }

    totalGas += result.gasUsed;
  }

  const averageGas = totalGas / BigInt(results.length);
  const recommendedGas = roundUp(
    applySafetyMargin(maxGas, safetyPercent),
    roundTo,
  );

  return {
    maxGas,
    averageGas,
    recommendedGas,
  };
}

/*
 * ============================================================
 * MAIN
 * ============================================================
 */

async function main(): Promise<void> {
  const startedAt = performance.now();

  /*
   * ----------------------------------------------------------
   * Parse arguments manually.
   *
   * We intentionally keep this tool independent from cli.ts.
   * ----------------------------------------------------------
   */

  const args = process.argv.slice(2);

  const options: CliOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--slug":
        options.slug = args[++i];
        break;

      case "--chain-id":
        options.chainId = args[++i];
        break;

      case "--wallet":
        options.wallet = args[++i];
        break;

      case "--quantity":
        options.quantity = args[++i];
        break;

      case "--safety":
        options.safety = args[++i];
        break;

      case "--round":
        options.round = args[++i];
        break;

      case "--help":
      case "-h":
        printHelp();
        return;

      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.slug) {
    throw new Error("Missing required option: --slug");
  }

  if (!options.chainId) {
    throw new Error("Missing required option: --chain-id");
  }

  if (!options.wallet) {
    throw new Error("Missing required option: --wallet");
  }

  const chainId = parsePositiveInt(
    options.chainId,
    "chain-id",
  );

  const quantity = options.quantity
    ? parsePositiveInt(options.quantity, "quantity")
    : DEFAULT_QUANTITY;

  const wallet = normalizeAddress(
    options.wallet,
    "wallet",
  );

  const safetyPercent = options.safety
    ? parseNonNegativeInt(
        options.safety,
        "safety",
      )
    : DEFAULT_SAFETY_PERCENT;

  const roundTo = options.round
    ? BigInt(
        parsePositiveInt(
          options.round,
          "round",
        ),
      )
    : DEFAULT_ROUND_TO;

  /*
   * ----------------------------------------------------------
   * Chain / RPC
   * ----------------------------------------------------------
   */

  const { chain, rpcUrls } = resolveChain(chainId);

  const extraRpcUrls = config.extraRpcUrls.filter(
    (url) => !rpcUrls.includes(url),
  );

  const allRpcUrls = [
    ...rpcUrls,
    ...extraRpcUrls,
  ];

  if (allRpcUrls.length === 0) {
    throw new Error(
      `No RPC URLs configured for chain ${chainId}.`,
    );
  }

  /*
   * ----------------------------------------------------------
   * Header
   * ----------------------------------------------------------
   */

  console.log("");
  console.log("========================================");
  console.log("       NFT GAS PRE-ESTIMATE TOOL");
  console.log("========================================");
  console.log(`Collection : ${options.slug}`);
  console.log(`Chain      : ${chain.name} (${chainId})`);
  console.log(`Wallet     : ${wallet}`);
  console.log(`Quantity   : ${quantity}`);
  console.log(`RPCs       : ${allRpcUrls.length}`);
  console.log(`Safety     : +${safetyPercent}%`);
  console.log(`Round      : ${roundTo}`);
  console.log("========================================");
  console.log("");

  /*
   * ----------------------------------------------------------
   * Wallet / RPC clients
   * ----------------------------------------------------------
   */

  const openSea = new OpenSeaClient(
    config.openSeaApiKey,
  );

  const clients = createClients(
    chain,
    allRpcUrls,
  );

  /*
   * ----------------------------------------------------------
   * 1. Fetch drop
   * ----------------------------------------------------------
   */

  console.log(
    "[COLLECTION] Fetching drop info + phases...",
  );

  const dropStartedAt = performance.now();

  const drop = await openSea.getDrop(
    options.slug,
  );

  console.log(
    `[COLLECTION] ${drop.name ?? options.slug} — ` +
      `${drop.stages.length} phase(s) ` +
      `(${elapsed(dropStartedAt)})`,
  );

  if (drop.stages.length === 0) {
    throw new Error(
      "Collection has no mint phases.",
    );
  }

  /*
   * ----------------------------------------------------------
   * 2. Display phases
   * ----------------------------------------------------------
   */

  const nowSec = nowUnixSeconds();

  console.log("");
  console.log("[PHASES]");

  for (const stage of drop.stages) {
    let state = "UNKNOWN";

    if (isActive(stage, nowSec)) {
      state = "ACTIVE";
    } else if (isFuture(stage, nowSec)) {
      state = "FUTURE";
    } else if (isExpired(stage, nowSec)) {
      state = "EXPIRED";
    }

    const eligibility =
      stage.eligible === undefined
        ? "unknown"
        : stage.eligible
          ? "eligible"
          : "NOT eligible";

    console.log(
      `  - ${stage.label} | ${state} | ${eligibility} | ` +
        `${formatDate(stage.startTime)}`,
    );
  }

  /*
   * ----------------------------------------------------------
   * 3. Determine current active phase
   * ----------------------------------------------------------
   *
   * Important:
   *
   * OpenSea's /mint endpoint is the authority for whether the
   * wallet can actually mint.
   *
   * The phase eligibility field from GET /drops can be stale or
   * incomplete.
   * ----------------------------------------------------------
   */

  const activeStages = drop.stages
    .filter((stage) =>
      isActive(stage, nowSec),
    )
    .sort(
      (a, b) =>
        (a.startTime ?? 0) -
        (b.startTime ?? 0),
    );

  if (activeStages.length === 0) {
    const futureStages = drop.stages
      .filter((stage) =>
        isFuture(stage, nowSec),
      )
      .sort(
        (a, b) =>
          (a.startTime ?? 0) -
          (b.startTime ?? 0),
      );

    console.log("");

    if (futureStages.length > 0) {
      const next = futureStages[0];

      console.log(
        `[PHASE] No phase is active right now.`,
      );

      console.log(
        `[PHASE] Next phase: "${next.label}" @ ` +
          `${formatDate(next.startTime)}`,
      );

      console.log("");
      console.log(
        "[INFO] OpenSea /mint cannot reliably produce " +
          "the future phase calldata before that phase is active.",
      );

      console.log(
        "[INFO] Run this tool again when the target phase becomes active.",
      );

      console.log("");
      console.log(
        "[SAFE] No transaction signed.",
      );
      console.log(
        "[SAFE] No transaction broadcast.",
      );

      return;
    }

    throw new Error(
      "No active or future mint phase found.",
    );
  }

  /*
   * ----------------------------------------------------------
   * 4. Try active phases
   * ----------------------------------------------------------
   *
   * Usually there is only one active phase.
   *
   * We still iterate so the tool remains robust if an OpenSea
   * drop has overlapping phases.
   *
   * IMPORTANT:
   *
   * We do NOT permanently blacklist a phase based on a 422.
   * This tool only runs one pre-estimation session.
   * ----------------------------------------------------------
   */

  let mintTx:
    | {
        to: Address;
        data: `0x${string}`;
        value: bigint;
      }
    | undefined;

  let successfulStage: MintStage | undefined;

  for (const stage of activeStages) {
    console.log("");
    console.log(
      `[PHASE] Trying active phase: "${stage.label}"`,
    );

    if (stage.startTime !== undefined) {
      console.log(
        `[PHASE] Started: ${formatDate(stage.startTime)}`,
      );
    }

    if (stage.endTime !== undefined) {
      console.log(
        `[PHASE] Ends:    ${formatDate(stage.endTime)}`,
      );
    }

    /*
     * --------------------------------------------------------
     * OpenSea /mint
     * --------------------------------------------------------
     */

    console.log(
      "[MINT] Building exact mint calldata...",
    );

    const mintStartedAt = performance.now();

    try {
      const result =
        await openSea.buildMintTransaction(
          options.slug,
          wallet,
          quantity,
        );

      mintTx = {
        to: result.to,
        data: result.data,
        value: result.value,
      };

      successfulStage = stage;

      console.log(
        `[MINT] OK — calldata built ` +
          `(${elapsed(mintStartedAt)})`,
      );

      break;
    } catch (error) {
      const message = errorMessage(error);

      /*
       * OpenSeaClient currently throws messages like:
       *
       * OpenSea API 422: ...
       *
       * OpenSea API 409: ...
       */

      if (
        message.includes("OpenSea API 422")
      ) {
        console.log(
          `[MINT] 422 — wallet is NOT eligible ` +
            `for "${stage.label}".`,
        );

        continue;
      }

      if (
        message.includes("OpenSea API 409")
      ) {
        console.log(
          `[MINT] 409 — drop is not currently active ` +
            `for "${stage.label}".`,
        );

        continue;
      }

      throw new Error(
        `OpenSea /mint failed for "${stage.label}": ${message}`,
      );
    }
  }

  /*
   * ----------------------------------------------------------
   * 5. No calldata
   * ----------------------------------------------------------
   */

  if (!mintTx) {
    console.log("");
    console.log("[RESULT] No valid mint calldata for this wallet.");
    console.log(
      "[SAFE] This wallet is NOT eligible for the active phase.",
    );
    console.log(
      "[SAFE] No mint calldata will be signed or broadcast.",
    );

    /*
     * ----------------------------------------------------------
     * HISTORICAL FALLBACK
     * ----------------------------------------------------------
     *
     * This path is ONLY for gas planning.
     *
     * It deliberately does not create a transaction object for
     * the current wallet and never calls a wallet/signer.
     * ----------------------------------------------------------
     */

    const references = loadHistoricalReferences(options.slug);

    if (references.length === 0) {
      console.log("");
      console.log(
        "[FALLBACK] No historical references found.",
      );
      console.log(
        `[FALLBACK] Optional file: ${HISTORICAL_CONFIG_NAME}`,
      );
      console.log(
        '[FALLBACK] Example: {"robominttest":{"transactions":[{"hash":"0x..."}]}}',
      );
      console.log("");
      console.log("[SAFE] No transaction signed.");
      console.log("[SAFE] No transaction broadcast.");
      return;
    }

    console.log("");
    console.log(
      `[FALLBACK] Found ${references.length} historical reference(s).`,
    );
    console.log(
      "[FALLBACK] Reading successful transaction receipts...",
    );

    const historical = await estimateHistoricalGas(
      clients,
      allRpcUrls,
      references,
    );

    if (historical.length === 0) {
      console.log(
        "[FALLBACK] Could not obtain any successful historical gas reference.",
      );
      console.log("[SAFE] No transaction signed.");
      console.log("[SAFE] No transaction broadcast.");
      return;
    }

    const historicalRecommendation =
      calculateHistoricalRecommendation(
        historical,
        safetyPercent,
        roundTo,
      );

    console.log("");
    console.log("========================================");
    console.log("       HISTORICAL GAS FALLBACK");
    console.log("========================================");

    for (const result of historical) {
      console.log(
        `Reference gasUsed : ${result.gasUsed} ` +
          `@ ${result.rpcUrl}`,
      );
      console.log(
        `Reference TX      : ${result.hash}`,
      );
    }

    console.log(
      `Highest gasUsed   : ${historicalRecommendation.maxGas}`,
    );
    console.log(
      `Average gasUsed   : ${historicalRecommendation.averageGas}`,
    );
    console.log(
      `Safety margin     : +${safetyPercent}%`,
    );
    console.log(
      `Recommended limit : ${historicalRecommendation.recommendedGas}`,
    );

    console.log("========================================");
    console.log("");
    console.log(
      "[WARNING] Historical gasUsed is NOT an exact estimate",
    );
    console.log(
      "[WARNING] for this wallet or the future mint phase.",
    );
    console.log(
      "[WARNING] Use it only as a conservative planning value.",
    );
    console.log("");
    console.log("[SAFE] No transaction signed.");
    console.log("[SAFE] No transaction broadcast.");
    console.log("");

    return;
  }

  /*
   * ----------------------------------------------------------
   * 6. Calldata summary
   * ----------------------------------------------------------
   */

  console.log("");
  console.log("[CALldata]");

  console.log(`  To       : ${mintTx.to}`);
  console.log(`  Value    : ${mintTx.value} wei`);
  console.log(
    `  Data     : ${mintTx.data.length} hex chars`,
  );

  console.log(
    `  Phase    : ${successfulStage?.label ?? "unknown"}`,
  );

  /*
   * ----------------------------------------------------------
   * 7. Estimate gas across all RPCs
   * ----------------------------------------------------------
   */

  console.log("");
  console.log(
    `[GAS] Estimating across ${allRpcUrls.length} RPC(s)...`,
  );

  const gasStartedAt = performance.now();

  const estimates =
    await estimateGasAcrossRpc(
      clients,
      allRpcUrls,
      wallet,
      mintTx.to,
      mintTx.data,
      mintTx.value,
    );

  /*
   * ----------------------------------------------------------
   * 8. Select highest successful estimate
   * ----------------------------------------------------------
   *
   * Example:
   *
   * RPC A = 91,318
   * RPC B = 92,102
   *
   * Base = 92,102
   *
   * This is deliberately conservative.
   * ----------------------------------------------------------
   */

  const highestEstimate =
    estimates.reduce(
      (max, item) =>
        item.gas > max
          ? item.gas
          : max,
      0n,
    );

  /*
   * ----------------------------------------------------------
   * 9. +50% safety margin
   * ----------------------------------------------------------
   */

  const safetyGas =
    applySafetyMargin(
      highestEstimate,
      safetyPercent,
    );

  /*
   * ----------------------------------------------------------
   * 10. Round upward
   * ----------------------------------------------------------
   */

  const recommendedGas =
    roundUp(
      safetyGas,
      roundTo,
    );

  /*
   * ----------------------------------------------------------
   * 11. Results
   * ----------------------------------------------------------
   */

  console.log("");

  console.log(
    "========================================",
  );
  console.log(
    "           GAS ESTIMATE RESULT",
  );
  console.log(
    "========================================",
  );

  console.log(
    `Phase              : ${successfulStage?.label ?? "unknown"}`,
  );

  console.log(
    `RPC estimates      : ${estimates.length}/${allRpcUrls.length}`,
  );

  console.log(
    `Highest estimate   : ${highestEstimate}`,
  );

  console.log(
    `Safety margin      : +${safetyPercent}%`,
  );

  console.log(
    `With safety        : ${safetyGas}`,
  );

  console.log(
    `Rounded            : ${recommendedGas}`,
  );

  console.log(
    `Estimation time    : ${elapsed(gasStartedAt)}`,
  );

  console.log(
    "========================================",
  );

  /*
   * ----------------------------------------------------------
   * 12. Copy/paste command
   * ----------------------------------------------------------
   */

  console.log("");
  console.log(
    "========================================",
  );
  console.log(
    "        RECOMMENDED MINT COMMAND",
  );
  console.log(
    "========================================",
  );

  console.log("");

  console.log(
    `npx tsx src/cli.ts ` +
      `--slug ${options.slug} ` +
      `--chain-id ${chainId} ` +
      `--wallet ${wallet} ` +
      `--quantity ${quantity} ` +
      `--gas-limit ${recommendedGas} ` +
      `--confirm`,
  );

  console.log("");

  console.log(
    `Use: --gas-limit ${recommendedGas}`,
  );

  console.log("");

  console.log(
    "[SAFE] No transaction signed.",
  );

  console.log(
    "[SAFE] No transaction broadcast.",
  );

  console.log(
    `[DONE] Total tool time: ${elapsed(startedAt)}`,
  );

  console.log("");
}

/*
 * ============================================================
 * HELP
 * ============================================================
 */

function printHelp(): void {
  console.log(`
NFT Mint Gas Pre-Estimate Tool

Usage:

  npx tsx src/tools/gas-preestimate.ts \\
    --slug <slug> \\
    --chain-id <chainId> \\
    --wallet <address> \\
    [--quantity <quantity>] \\
    [--safety <percent>] \\
    [--round <gas>]

Fallback:
  If OpenSea /mint returns 422 for the current wallet, the tool
  never signs/broadcasts. It may use optional historical references
  from ./gas-reference.json to calculate a conservative gas limit.

Required:

  --slug       OpenSea drop/collection slug
  --chain-id   EVM chain ID
  --wallet     Mint wallet address

Optional:

  --quantity   Mint quantity
               Default: 1

  --safety     Gas safety margin percentage
               Default: 50

  --round      Round recommended gas upward to this unit
               Default: 1000

Examples:

  npx tsx src/tools/gas-preestimate.ts \\
    --slug robominttest \\
    --chain-id 4663 \\
    --wallet 0x0CbA5D0cd0c6a7e8581A4e57684B069a8C024F16

Custom safety:

  npx tsx src/tools/gas-preestimate.ts \\
    --slug robominttest \\
    --chain-id 4663 \\
    --wallet 0x0CbA5D0cd0c6a7e8581A4e57684B069a8C024F16 \\
    --quantity 1 \\
    --safety 50

Custom rounding:

  npx tsx src/tools/gas-preestimate.ts \\
    --slug robominttest \\
    --chain-id 4663 \\
    --wallet 0x0CbA5D0cd0c6a7e8581A4e57684B069a8C024F16 \\
    --round 10000

Fallback file example (project root):

  {
    "robominttest": {
      "transactions": [
        { "hash": "0xYOUR_SUCCESSFUL_MINT_TX_HASH" },
        { "gasUsed": 86225 }
      ]
    }
  }

Safety:

  This tool NEVER signs or broadcasts a transaction.
`);
}

/*
 * ============================================================
 * ENTRY POINT
 * ============================================================
 */

main().catch((error: unknown) => {
  console.error("");
  console.error(
    "[ERROR]",
    error instanceof Error
      ? error.message
      : String(error),
  );

  console.error("");

  process.exitCode = 1;
});