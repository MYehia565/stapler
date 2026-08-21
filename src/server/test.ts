import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
} from "@paperclipai/adapter-utils";

import {
  validateStaplerConfig,
} from "./config.js";
import {
  listStaplerModels,
} from "./models.js";
import {
  LOCAL_TOOL_NAMES,
} from "./local-tools.js";
import {
  discoverStaplerSlots,
  providerApiKeyEnvName,
  resolveProviderApiKey,
  resolveProviderBaseUrl,
  resolveProviderId,
  resolveProviderLabel,
} from "./providers.js";
import {
  resolvePaperclipAuthToken,
} from "./tool-gateway.js";

function paperclipGatewayAuthCheck(
  ctx: AdapterEnvironmentTestContext,
  config: Record<string, unknown>,
): AdapterEnvironmentTestResult["checks"][number] {
  const paperclipAuth =
    resolvePaperclipAuthToken(
      ctx as unknown as AdapterExecutionContext,
      config,
    );

  if (paperclipAuth) {
    return {
      code: "paperclip_gateway_auth",
      level: "info",
      message:
        "Paperclip API auth material is present for this probe. A live Tool Gateway session is only created during agent runs when the host mints ctx.authToken (requires supportsLocalAgentJwt).",
    };
  }

  return {
    code: "paperclip_gateway_auth",
    level: "warn",
    message:
      "Paperclip API auth was not found on this probe. Local workspace tools will still work; governed Paperclip tools need a run JWT (supportsLocalAgentJwt) or PAPERCLIP_API_KEY.",
    hint:
      "Redeploy this adapter with supportsLocalAgentJwt enabled, then re-run an agent. Do not confuse a successful LLM provider check with Tool Gateway access.",
  };
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config =
    (ctx.config ?? {}) as Record<
      string,
      unknown
    >;

  const configErrors =
    validateStaplerConfig(config);

  if (configErrors.length) {
    return {
      adapterType:
        ctx.adapterType,
      status: "fail",
      testedAt:
        new Date().toISOString(),
      checks:
        configErrors.map(
          (message, index) => ({
            code:
              `invalid_config_${index + 1}`,
            level: "error" as const,
            message,
          }),
        ),
    };
  }

  const providerLabel = resolveProviderLabel(config);
  const providerId = resolveProviderId(config);
  const baseUrl = resolveProviderBaseUrl(config);
  const apiKeyEnv = providerApiKeyEnvName(config);
  const key = resolveProviderApiKey(config);
  const allSlots = discoverStaplerSlots(config)
    .map((slot) => slot.id)
    .join(", ");

  if (!key) {
    return {
      adapterType:
        ctx.adapterType,
      status: "fail",
      testedAt:
        new Date().toISOString(),
      checks: [
        {
          code:
            "missing_api_key",
          level: "error",
          message:
            `${providerLabel} API key is not configured.`,
          hint:
            `Bind ${apiKeyEnv} through Environment variables / Secret access.`,
        },
      ],
    };
  }

  const url = `${baseUrl}/models`;

  try {
    const response =
      await fetch(
        url,
        {
          method: "GET",
          headers: {
            Authorization:
              `Bearer ${key}`,
            Accept:
              "application/json",
          },
        },
      );

    const body =
      await response.text();

    if (!response.ok) {
      return {
        adapterType:
          ctx.adapterType,
        status: "fail",
        testedAt:
          new Date().toISOString(),
        checks: [
          {
            code:
              "api_error",
            level: "error",
            message:
              `${providerLabel} returned HTTP ${response.status} from ${url}.`,
            hint:
              body.slice(
                0,
                2000,
              ),
          },
        ],
      };
    }

    let models =
      [];

    try {
      models =
        await listStaplerModels(
          config,
        );
    } catch {
      // The HTTP check already succeeded.
    }

    return {
      adapterType:
        ctx.adapterType,
      status: "pass",
      testedAt:
        new Date().toISOString(),
      checks: [
        {
          code:
            "provider_selected",
          level: "info",
          message:
            `provider=${providerId} baseUrl=${baseUrl}`,
        },
        {
          code:
            "slot_inventory",
          level: "info",
          message:
            `Configured Stapler slots: ${allSlots || providerId}.`,
        },
        {
          code:
            "api_ok",
          level: "info",
          message:
            `Connected to ${providerLabel}. ${models.length} model(s) discovered for this slot.`,
        },
        {
          code:
            "workspace_tools",
          level: "info",
          message:
            `Local workspace tools registered: ${LOCAL_TOOL_NAMES.join(", ")}.`,
        },
        paperclipGatewayAuthCheck(ctx, config),
      ],
    };
  } catch (error) {
    return {
      adapterType:
        ctx.adapterType,
      status: "fail",
      testedAt:
        new Date().toISOString(),
      checks: [
        {
          code:
            "network_error",
          level: "error",
          message:
            error instanceof
            Error
              ? error.message
              : String(error),
        },
      ],
    };
  }
}
