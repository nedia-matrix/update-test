export interface TextRule {
  readonly value: string;
  readonly exact: boolean;
}

export type LocatorCandidate =
  | { readonly kind: "test-id"; readonly value: string }
  | {
      readonly kind: "aria";
      readonly role?: string;
      readonly name?: TextRule;
    }
  | { readonly kind: "label"; readonly text: TextRule }
  | { readonly kind: "text"; readonly text: TextRule }
  | { readonly kind: "css"; readonly selector: string };

export interface ElementState {
  readonly attached: boolean;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly editable: boolean;
}

export interface ElementReference {
  readonly id: string;
  readonly state: ElementState;
}

export interface EvidenceReference {
  readonly id: string;
  readonly capturedAt: string;
  readonly reason: string;
  readonly mimeType?: string;
  readonly byteSize?: number;
  readonly relativeRef?: string;
  readonly width?: number;
  readonly height?: number;
}

export type AutomationKey = "Enter" | "Space";

export interface AutomationDriver {
  currentUrl(): Promise<string>;
  navigate(url: string): Promise<void>;
  wait(milliseconds: number): Promise<void>;
  query(candidate: LocatorCandidate): Promise<readonly ElementReference[]>;
  prepareCommit?(): Promise<void>;
  click(target: ElementReference): Promise<void>;
  clickAtPosition(
    target: ElementReference,
    xRatio: number,
    yRatio: number,
  ): Promise<void>;
  clickClosedShadowDescendant(
    target: ElementReference,
    descendantTag: string,
    descendantClass: string,
  ): Promise<void>;
  fill(target: ElementReference, value: string): Promise<void>;
  typeText(
    target: ElementReference,
    value: string,
    delayMs?: number,
  ): Promise<void>;
  pressKey(target: ElementReference, key: AutomationKey): Promise<void>;
  uploadFiles(
    target: ElementReference,
    filePaths: readonly string[],
  ): Promise<void>;
  dropFiles(
    target: ElementReference,
    filePaths: readonly string[],
  ): Promise<void>;
  textContent(target: ElementReference): Promise<string | null>;
  attribute(target: ElementReference, name: string): Promise<string | null>;
  captureEvidence(reason: string): Promise<EvidenceReference>;
}
