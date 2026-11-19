// Loads qa.config.json: environments, circuit-breaker thresholds, per-run limits and models.
// Set QA_CONFIG to use a different file.
import { readFileSync } from "node:fs";

type Environment = { label: string; baseUrl: string; healthPath: string };
export type Config = {
  environments: Record<string, Environment>;
  defaultEnvironment: string;
  circuitBreaker: { minFailingRequests: number; failingRequestPercent: number };
  serverErrors: { terminateAtPercent: number; minRequests: number; recheckAfterSeconds: number };
  limits: { healsPerRun: number; newKnownBugsPerRun: number; attemptsPerRequest: number };
  models: { default: string } & Record<string, string>;
};

export const config: Config = JSON.parse(
  readFileSync(process.env.QA_CONFIG ?? new URL("./qa.config.json", import.meta.url), "utf8"),
);

let current = config.defaultEnvironment;

export function selectEnvironment(name: string) {
  const e = config.environments[name];
  if (!e) throw new Error(`Unknown environment "${name}". Configured: ${Object.keys(config.environments).join(", ")}`);
  if (!e.baseUrl) throw new Error(`No baseUrl configured for "${name}" in qa.config.json`);
  current = name;
}

export function env() {
  const e = config.environments[current];
  return { name: current, ...e, host: new URL(e.baseUrl).host };
}

export const serverIssueMessage = () => `Facing server issues, please check ${env().label} Env`;

// The model for one agent: models.<agent> if set, otherwise models.default.
export const modelFor = (agent: string) => config.models[agent] ?? config.models.default;
