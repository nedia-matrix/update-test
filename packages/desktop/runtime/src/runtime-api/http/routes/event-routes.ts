import type { ServerResponse } from "node:http";

import type { RuntimeEventBuffer } from "../../events/runtime-event-buffer.js";
import { writeJson } from "../http-json.js";

export class RuntimeEventRoutes<Event> {
  constructor(
    private readonly events: RuntimeEventBuffer<Event>,
    private readonly visible: (event: Event) => boolean = () => true,
  ) {}

  async poll(
    response: ServerResponse,
    afterValue: string | null,
  ): Promise<void> {
    try {
      const after = afterValue === null ? 0 : Number(afterValue);
      const envelope = await this.events.poll(after, 20_000);
      if (!response.destroyed)
        writeJson(response, 200, {
          ...envelope,
          events: envelope.events.filter(this.visible),
        });
    } catch (error) {
      if (!response.destroyed) {
        writeJson(response, 400, {
          code: "INVALID_EVENT_CURSOR",
          message: error instanceof Error ? error.message : "Invalid cursor",
        });
      }
    }
  }
}
