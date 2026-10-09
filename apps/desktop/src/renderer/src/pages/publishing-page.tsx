import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import type { AppContext } from "../app-context.js";
import { Icon } from "../components/icons.js";
import {
  publicationComposeHref,
  publicationRecordsHref,
  onPublishingRouteChange,
  readPublishingRoute,
  type PublicationRecordFilters,
  type PublishingTab,
} from "../publishing-route.js";
import { PublicationsPage } from "./publications-page.js";
import { PublishPage } from "./publish-page.js";

const tabs: readonly { id: PublishingTab; label: string }[] = [
  { id: "records", label: "发布记录" },
  { id: "compose", label: "内容发布" },
];

export function PublishingPage({
  context,
  preferredAccountId,
}: {
  context: AppContext;
  preferredAccountId?: string;
}) {
  const initialRoute = readPublishingRoute(globalThis.location.hash);
  const [activeTab, setActiveTab] = useState(initialRoute.tab);
  const [filters, setFilters] = useState(initialRoute.filters);
  const [focusedPublicationId, setFocusedPublicationId] = useState(
    initialRoute.publicationId,
  );
  const [editorVisited, setEditorVisited] = useState(
    initialRoute.tab === "compose",
  );
  const [draftRevision, setDraftRevision] = useState(0);
  const loadedDraft = useRef(context.recreatedDraft);
  const rootRef = useRef<HTMLDivElement>(null);
  const [headerActionsTarget, setHeaderActionsTarget] =
    useState<HTMLDivElement | null>(null);

  useEffect(() => {
    return onPublishingRouteChange((route) => {
      setActiveTab(route.tab);
      if (route.tab === "records") {
        setFilters(route.filters);
        setFocusedPublicationId(route.publicationId);
        globalThis.history.replaceState(
          null,
          "",
          publicationRecordsHref(route.filters, route.publicationId),
        );
      } else {
        setEditorVisited(true);
        if (
          context.recreatedDraft &&
          context.recreatedDraft !== loadedDraft.current
        ) {
          loadedDraft.current = context.recreatedDraft;
          setDraftRevision((revision) => revision + 1);
        }
      }
    });
  }, [context]);

  useEffect(() => {
    rootRef.current?.closest(".workspace")?.scrollTo({ top: 0 });
  }, [activeTab]);

  const changeFilters = useCallback((next: PublicationRecordFilters) => {
    setFilters(next);
    setFocusedPublicationId(undefined);
    globalThis.history.replaceState(null, "", publicationRecordsHref(next));
  }, []);

  const selectTab = (tab: PublishingTab) => {
    globalThis.location.hash =
      tab === "compose"
        ? publicationComposeHref
        : publicationRecordsHref(filters, focusedPublicationId);
  };

  return (
    <div class="publishing-page" ref={rootRef}>
      <header class="workspace-header publishing-header">
        <span class="workspace-header-icon" aria-hidden="true">
          <Icon name="publish" size={24} />
        </span>
        <div class="workspace-header-copy">
          <h1>内容发布</h1>
          <p>创建发布内容，查看发布记录与处理进度。</p>
        </div>
        <div
          class="workspace-header-actions publishing-header-actions"
          ref={setHeaderActionsTarget}
        />
      </header>
      <nav
        class="workspace-tabs publishing-tabs"
        role="tablist"
        aria-label="内容发布"
      >
        {tabs.map(({ id, label }, index) => (
          <button
            key={id}
            id={`publishing-tab-${id}`}
            class={activeTab === id ? "active" : undefined}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            aria-controls={`publishing-panel-${id}`}
            tabIndex={activeTab === id ? 0 : -1}
            onClick={() => selectTab(id)}
            onKeyDown={(event) => {
              const nextIndex =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : event.key === "ArrowRight"
                      ? (index + 1) % tabs.length
                      : event.key === "ArrowLeft"
                        ? (index + tabs.length - 1) % tabs.length
                        : undefined;
              if (nextIndex === undefined) return;
              event.preventDefault();
              const next = tabs[nextIndex]!;
              document.getElementById(`publishing-tab-${next.id}`)?.focus();
              selectTab(next.id);
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      <section
        id="publishing-panel-records"
        class="publishing-tab-panel"
        role="tabpanel"
        aria-labelledby="publishing-tab-records"
        hidden={activeTab !== "records"}
      >
        <PublicationsPage
          context={context}
          active={activeTab === "records"}
          headerActionsTarget={headerActionsTarget}
          filters={filters}
          onFiltersChange={changeFilters}
          focusedPublicationId={focusedPublicationId}
        />
      </section>
      <section
        id="publishing-panel-compose"
        class="publishing-tab-panel"
        role="tabpanel"
        aria-labelledby="publishing-tab-compose"
        hidden={activeTab !== "compose"}
      >
        {editorVisited && (
          <PublishPage
            key={draftRevision}
            context={context}
            preferredAccountId={preferredAccountId}
            active={activeTab === "compose"}
            headerActionsTarget={headerActionsTarget}
          />
        )}
      </section>
    </div>
  );
}
