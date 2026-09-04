import type { Persona } from "agentcursor" with {
  "resolution-mode": "import",
};

export const INTERACTION_STYLE = "slow-natural" as const;
export const SLOW_NATURAL_SPEED_FACTOR = 0.6;

export interface SlowNaturalPersonaOptions {
  seed?: number;
  now?: () => number;
}

export type AgentPersonaProvider = () => Promise<Persona>;

type AgentCursorModule = typeof import("agentcursor", {
  with: { "resolution-mode": "import" },
});

let agentCursorModule: Promise<AgentCursorModule> | null = null;

function loadAgentCursor(): Promise<AgentCursorModule> {
  return (agentCursorModule ??= import("agentcursor"));
}

export async function createSlowNaturalPersona(
  options: SlowNaturalPersonaOptions = {},
): Promise<Persona> {
  const { createPersona } = await loadAgentCursor();
  const persona = createPersona(options.seed, { now: options.now });
  persona.base.speedFactor = SLOW_NATURAL_SPEED_FACTOR;
  return persona;
}

export function createSlowNaturalPersonaProvider(
  options: SlowNaturalPersonaOptions = {},
): AgentPersonaProvider {
  let persona: Promise<Persona> | null = null;
  return () => (persona ??= createSlowNaturalPersona(options));
}
