/** Minimum creator note fields, deliberately excludes optional publishing features. */
export function buildXhsCommonNote(
  title: string,
  body: string,
  type: "normal" | "video",
) {
  return {
    type,
    title,
    desc: body,
    note_id: "",
    source: JSON.stringify({
      type: "web",
      ids: "",
      extraInfo: JSON.stringify({ subType: "official", systemId: "web" }),
    }),
    business_binds: JSON.stringify({
      version: 1,
      noteId: 0,
      bizType: 0,
      noteOrderBind: {},
      notePostTiming: {},
      noteCollectionBind: { id: "" },
      noteSketchCollectionBind: { id: "" },
      interactionPermissionBind: { commentPermission: 0 },
      optionRelationList: [],
    }),
    ats: [],
    hash_tag: [],
    post_loc: {},
    privacy_info: { op_type: 1, type: 0, user_ids: [] },
    goods_info: {},
    biz_relations: [],
  };
}
