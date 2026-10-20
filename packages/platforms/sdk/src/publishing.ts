import type { AutomationWorkflow } from "@nedia-matrix/automation-engine";
import { z } from "zod";

export const publishContentForms = ["video", "imageText", "longText"] as const;
export type PublishContentForm = (typeof publishContentForms)[number];

export const submissionModes = ["automatic", "manual_confirmation"] as const;
export type SubmissionMode = (typeof submissionModes)[number];

export const publishConstraintsSchema = z.object({
  titleMaxLength: z.number().int().positive().optional(),
  bodyMaxLength: z.number().int().positive().optional(),
  mediaMaxCount: z.number().int().positive().optional(),
});
export type PublishConstraints = z.infer<typeof publishConstraintsSchema>;

export const publishTagPolicySchema = z.object({
  placement: z.enum(["inline", "new-lines"]),
  maxCount: z.number().int().positive().optional(),
});
export type PublishTagPolicy = z.infer<typeof publishTagPolicySchema>;

export interface PlatformPublishAutomation {
  readonly prepare: AutomationWorkflow;
  readonly submit: AutomationWorkflow;
}

export interface PlatformPublishFormBase {
  readonly constraints: PublishConstraints;
  readonly tagPolicy?: PublishTagPolicy;
  readonly submissionModes: readonly SubmissionMode[];
  readonly descriptionComposition?: {
    readonly parts: readonly ("title" | "body")[];
    readonly separator: string;
  };
}
export interface PlatformWorkflowFormCapability extends PlatformPublishFormBase {
  readonly executionMode?: "workflow";
  readonly automation: PlatformPublishAutomation;
}
export interface PlatformPublisherFormCapability extends PlatformPublishFormBase {
  readonly executionMode: "publisher";
  readonly adapterId: string;
}
export type PlatformPublishFormCapability =
  PlatformWorkflowFormCapability | PlatformPublisherFormCapability;
