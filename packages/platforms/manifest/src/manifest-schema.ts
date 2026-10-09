import {
  automationPageSchema,
  workflowStepSchema,
} from "@nedia-matrix/automation-engine";
import {
  publishConstraintsSchema,
  publishContentForms,
  publishTagPolicySchema,
  submissionModes,
} from "@nedia-matrix/platform-sdk";
import { z } from "zod";

const fieldPathSchema = z
  .array(z.union([z.string().min(1), z.number().int().nonnegative()]))
  .min(1);

const sessionProbeSchema = z
  .object({
    identityScheme: z.string().min(1),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("request"), url: z.string().url() }),
      z.object({
        kind: z.literal("observed-response"),
        method: z.enum(["GET", "POST"]),
        url: z.string().url(),
        timeoutMs: z.number().int().positive().max(30_000).optional(),
      }),
    ]),
    fields: z.object({
      externalAccountId: fieldPathSchema,
      nickname: fieldPathSchema,
      avatarUrl: fieldPathSchema.optional(),
    }),
  })
  .strict();

const accountsManifestSchema = z
  .object({
    loginEntries: z
      .array(
        z
          .object({
            id: z.string().min(1),
            displayName: z.string().min(1),
            url: z.string().url(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    detection: z
      .object({
        probes: z.array(sessionProbeSchema).max(16).default([]),
        loggedOutUrl: z.string().url().optional(),
        domFallback: z
          .object({
            identityScheme: z.string().min(1),
            page: automationPageSchema.strict(),
            loggedOutTargetId: z.string().min(1),
            nicknameTargetId: z.string().min(1),
            accountIdTargetId: z.string().min(1),
            accountIdAttributes: z.array(z.string().min(1)).min(1).max(16),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((detection, context) => {
    if (
      detection.detection.probes.length === 0 &&
      detection.detection.domFallback === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["detection"],
        message: "At least one probe or a DOM fallback is required",
      });
    }
  });

const jsonScalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const valueConditionSchema: z.ZodType = z.lazy(() =>
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("exists"), path: fieldPathSchema }).strict(),
    z
      .object({
        op: z.literal("equals"),
        path: fieldPathSchema,
        value: jsonScalarSchema,
      })
      .strict(),
    z
      .object({
        op: z.literal("in"),
        path: fieldPathSchema,
        values: z.array(jsonScalarSchema).min(1).max(16),
      })
      .strict(),
    z
      .object({
        op: z.literal("contains"),
        path: fieldPathSchema,
        value: z.string(),
        caseSensitive: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        op: z.literal("all"),
        conditions: z.array(valueConditionSchema).min(1).max(16),
      })
      .strict(),
    z
      .object({
        op: z.literal("any"),
        conditions: z.array(valueConditionSchema).min(1).max(16),
      })
      .strict(),
    z
      .object({
        op: z.literal("not"),
        condition: valueConditionSchema,
      })
      .strict(),
  ]),
);

const resultPlanSchema = z
  .object({
    source: z
      .object({
        method: z.enum(["POST", "PUT", "PATCH"]),
        url: z.string().url(),
        maxResponseBytes: z.number().int().positive().max(2_000_000).optional(),
      })
      .strict(),
    contentIdPaths: z.array(fieldPathSchema).min(1).max(16),
    messagePaths: z.array(fieldPathSchema).max(16).optional(),
    acceptedWhen: valueConditionSchema.optional(),
    verificationWhen: valueConditionSchema.optional(),
    failureWhen: valueConditionSchema.optional(),
    uncertainWhen: valueConditionSchema.optional(),
    httpErrorResult: z.enum(["failed", "uncertain"]).optional(),
    contentUrlTemplate: z
      .string()
      .min(1)
      .refine(
        (value) =>
          value.includes("{contentId}") &&
          value.indexOf("{contentId}") === value.lastIndexOf("{contentId}") &&
          !value.includes("{", value.indexOf("{contentId}") + 1),
        "Template must contain exactly one {contentId} placeholder",
      ),
    pageAcceptedTexts: z.array(z.string().min(1)).max(16).optional(),
    verificationTimeoutMs: z.number().int().min(5_000).max(180_000).optional(),
  })
  .strict();

const publishFormManifestSchema = z
  .object({
    constraints: publishConstraintsSchema,
    tagPolicy: publishTagPolicySchema.optional(),
    submissionModes: z.array(z.enum(submissionModes)).min(1),
    descriptionComposition: z
      .object({
        parts: z.array(z.enum(["title", "body"])).min(1),
        separator: z.string(),
      })
      .strict()
      .optional(),
    automation: z
      .object({
        page: automationPageSchema.strict(),
        prepare: z
          .object({
            id: z.string().min(1),
            startUrl: z.string().url().optional(),
            steps: z.array(workflowStepSchema).max(100),
          })
          .strict(),
        submit: z
          .object({
            id: z.string().min(1),
            steps: z.array(workflowStepSchema).max(100),
          })
          .strict(),
      })
      .strict(),
    result: resultPlanSchema,
  })
  .strict();

export const platformManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^custom:[a-z0-9][a-z0-9-]{0,63}$/),
    displayName: z.string().min(1).max(200),
    browser: z
      .object({
        startUrl: z.string().url(),
        allowedHostSuffixes: z.array(z.string().min(1)).min(1).max(16),
      })
      .strict(),
    accounts: accountsManifestSchema,
    publishing: z
      .object({
        forms: z
          .record(z.enum(publishContentForms), publishFormManifestSchema)
          .refine((forms) => Object.keys(forms).length > 0, {
            message: "At least one publishing form is required",
          }),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PlatformManifestV1 = z.infer<typeof platformManifestV1Schema>;
export type ValueConditionV1 = z.infer<typeof valueConditionSchema>;
export type PublishResultObservationPlanV1 = z.infer<typeof resultPlanSchema>;

export function parsePlatformManifest(
  input: unknown,
):
  | { ok: true; manifest: PlatformManifestV1 }
  | { ok: false; error: z.ZodError } {
  const result = platformManifestV1Schema.safeParse(input);
  return result.success
    ? { ok: true, manifest: result.data }
    : { ok: false, error: result.error };
}
