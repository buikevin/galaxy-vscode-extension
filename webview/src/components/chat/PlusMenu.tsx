/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-25
 * @modify date 2026-03-25
 * @desc Configure Tools popup opened from the composer plus button. It exposes capability groups with per-tool checkboxes so users can test tool access at a fine-grained level.
 */

import { useState, type Ref } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import type {
  ExtensionToolGroup,
  ToolCapabilities,
  ToolToggleKey,
  ToolToggles,
} from "@shared/protocol";

type PlusMenuProps = Readonly<{
  /** Anchor ref used for outside-click detection. */
  anchorRef: Ref<HTMLDivElement>;
  /** Whether the popup is currently visible. */
  isOpen: boolean;
  /** Current capability-group settings. */
  toolCapabilities: ToolCapabilities;
  /** Current individual tool settings. */
  toolToggles: ToolToggles;
  /** Public tools discovered from installed extensions. */
  extensionToolGroups: readonly ExtensionToolGroup[];
  /** Current extension-tool toggle settings. */
  extensionToolToggles: Readonly<Record<string, boolean>>;
  /** Toggle the popup open or closed. */
  onToggleOpen: () => void;
  /** Apply new capability-group values. */
  onUpdateToolCapabilities: (next: ToolCapabilities) => void;
  /** Apply new individual tool values. */
  onUpdateToolToggles: (next: ToolToggles) => void;
  /** Apply new extension-tool values. */
  onUpdateExtensionToolToggles: (
    next: Readonly<Record<string, boolean>>
  ) => void;
}>;

type ToolItem = Readonly<{
  key: ToolToggleKey;
  label: string;
  description: string;
}>;

type CapabilityGroup = Readonly<{
  key: keyof ToolCapabilities;
  label: string;
  description: string;
  tools: readonly ToolItem[];
}>;

type ExtensionGroupState = Readonly<{
  checked: boolean;
  indeterminate: boolean;
  enabledCount: number;
}>;

const CAPABILITY_GROUPS: readonly CapabilityGroup[] = [
  {
    key: "readProject",
    label: "Read Project",
    description: "Đọc file, tài liệu và cấu trúc workspace.",
    tools: [
      { key: "read_file", label: "read_file", description: "Đọc file text theo vùng dòng." },
      { key: "find_test_files", label: "find_test_files", description: "Tìm file test hoặc source liên quan." },
      { key: "get_latest_test_failure", label: "get_latest_test_failure", description: "Lấy lỗi test gần nhất đã lưu." },
      { key: "get_latest_review_findings", label: "get_latest_review_findings", description: "Lấy review findings gần nhất đã lưu." },
      { key: "get_next_review_finding", label: "get_next_review_finding", description: "Lấy finding review tiếp theo chưa dismiss." },
      { key: "dismiss_review_finding", label: "dismiss_review_finding", description: "Dismiss một review finding theo id." },
      { key: "read_document", label: "read_document", description: "Đọc tài liệu như docx/pdf theo chunk." },
      { key: "grep", label: "grep", description: "Tìm text hoặc symbol theo pattern." },
      { key: "list_dir", label: "list_dir", description: "Liệt kê cây thư mục và file." },
      { key: "head", label: "head", description: "Xem nhanh phần đầu file." },
      { key: "tail", label: "tail", description: "Xem nhanh phần cuối file." },
    ],
  },
  {
    key: "editFiles",
    label: "Edit Files",
    description: "Cho phép agent sửa hoặc tạo file.",
    tools: [
      { key: "insert_file_at_line", label: "insert_file_at_line", description: "Chèn nội dung vào trước một dòng cụ thể." },
      { key: "edit_file_range", label: "edit_file_range", description: "Sửa targeted theo vùng dòng." },
      { key: "multi_edit_file_ranges", label: "multi_edit_file_ranges", description: "Sửa nhiều vùng dòng trong cùng một file." },
      { key: "write_file", label: "write_file", description: "Chỉ tạo file mới, không overwrite file đã tồn tại." },
    ],
  },
  {
    key: "runCommands",
    label: "Run Commands",
    description: "Cho phép agent chạy command trong terminal.",
    tools: [
      { key: "git_status", label: "git_status", description: "Đọc trạng thái working tree Git." },
      { key: "git_diff", label: "git_diff", description: "Đọc git diff, staged hoặc unstaged." },
      { key: "git_add", label: "git_add", description: "Stage file hoặc thư mục bằng git add." },
      { key: "git_commit", label: "git_commit", description: "Tạo commit Git với message cụ thể." },
      { key: "git_push", label: "git_push", description: "Push branch hiện tại hoặc branch chỉ định." },
      { key: "git_pull", label: "git_pull", description: "Pull thay đổi mới từ remote." },
      { key: "git_checkout", label: "git_checkout", description: "Checkout branch/ref hoặc tạo branch mới." },
      { key: "run_terminal_command", label: "run_terminal_command", description: "Tạo command terminal mới." },
      { key: "await_terminal_command", label: "await_terminal_command", description: "Chờ command nền hoàn thành." },
      { key: "get_terminal_output", label: "get_terminal_output", description: "Lấy output command đã chạy." },
      { key: "kill_terminal_command", label: "kill_terminal_command", description: "Dừng command terminal đang chạy." },
      { key: "run_project_command", label: "run_project_command", description: "Compatibility shim cho flow cũ." },
    ],
  },
  {
    key: "webResearch",
    label: "Web Research",
    description: "Tìm tài liệu lập trình và đọc nội dung web.",
    tools: [
      { key: "search_web", label: "search_web", description: "Tìm kiếm web." },
      { key: "extract_web", label: "extract_web", description: "Đọc nội dung chính của trang web." },
      { key: "map_web", label: "map_web", description: "Map cấu trúc website." },
      { key: "crawl_web", label: "crawl_web", description: "Crawl website theo scope." },
    ],
  },
  {
    key: "validation",
    label: "Validation",
    description: "Quality gate blocking: agent sẽ chạy validate phù hợp với dự án trước khi chốt.",
    tools: [
      { key: "validate_code", label: "validate_code", description: "Chọn validator theo ngôn ngữ/project type." },
    ],
  },
  {
    key: "review",
    label: "Review",
    description: "Quality gate blocking: agent sẽ chạy code review cuối phase trước khi chốt.",
    tools: [
      { key: "request_code_review", label: "request_code_review", description: "Chạy reviewer cuối phase." },
    ],
  },
  {
    key: "vscodeNative",
    label: "VS Code Native",
    description: "Dùng diff, search, problems và các khả năng native khác.",
    tools: [
      { key: "vscode_open_diff", label: "vscode_open_diff", description: "Mở diff editor native." },
      { key: "vscode_show_problems", label: "vscode_show_problems", description: "Mở Problems panel." },
      { key: "vscode_workspace_search", label: "vscode_workspace_search", description: "Search workspace bằng native search." },
      { key: "vscode_find_references", label: "vscode_find_references", description: "Tìm references native của VS Code." },
      { key: "search_extension_tools", label: "search_extension_tools", description: "Search local installed extension tool catalog." },
      { key: "activate_extension_tools", label: "activate_extension_tools", description: "Bật một số extension tools đã tìm thấy để dùng ở các lượt sau." },
    ],
  },
  {
    key: "galaxyDesign",
    label: "Galaxy Design",
    description: "Cho phép agent dùng các tool Galaxy Design.",
    tools: [
      { key: "galaxy_design_project_info", label: "galaxy_design_project_info", description: "Phân tích project hiện tại." },
      { key: "galaxy_design_registry", label: "galaxy_design_registry", description: "Tra cứu registry/component." },
      { key: "galaxy_design_init", label: "galaxy_design_init", description: "Khởi tạo Galaxy Design." },
      { key: "galaxy_design_add", label: "galaxy_design_add", description: "Thêm component Galaxy Design." },
    ],
  },
] as const;

function CheckboxIndicator(props: Readonly<{ checked: boolean; indeterminate?: boolean }>) {
  return (
    <span
      className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
        props.checked || props.indeterminate
          ? "border-sky-400 bg-sky-500 text-white"
          : "border-white/20 bg-transparent text-transparent"
      }`}
    >
      {props.indeterminate ? (
        <span className="h-0.5 w-2 rounded-full bg-white" />
      ) : props.checked ? (
        <Check className="h-3 w-3" />
      ) : null}
    </span>
  );
}

function TreeCheckbox(props: Readonly<{
  checked: boolean;
  indeterminate?: boolean;
  onClick: () => void;
  title: string;
}>) {
  return (
    <button
      type="button"
      className="mt-1 inline-flex h-5 w-5 items-center justify-center"
      onClick={props.onClick}
      title={props.title}
    >
      <CheckboxIndicator
        checked={props.checked}
        indeterminate={props.indeterminate}
      />
    </button>
  );
}

export function PlusMenu(props: PlusMenuProps) {
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    () =>
      Object.fromEntries(
        CAPABILITY_GROUPS.map((group) => [group.key, true])
      ) as Record<string, boolean>
  );

  const selectedBuiltInToolCount = Object.values(props.toolToggles).filter(Boolean).length;
  const activeExtensionToolGroups = props.extensionToolGroups.filter((group) =>
    group.tools.some((tool) => props.extensionToolToggles[tool.key] === true)
  );
  const selectedExtensionToolCount = activeExtensionToolGroups.reduce(
    (total, group) =>
      total +
      group.tools.filter((tool) => props.extensionToolToggles[tool.key] === true).length,
    0,
  );
  const selectedToolCount = selectedBuiltInToolCount + selectedExtensionToolCount;

  function toggleGroupExpanded(groupKey: string): void {
    setExpandedGroups((current) => ({
      ...current,
      [groupKey]: !current[groupKey],
    }));
  }

  function updateGroup(group: CapabilityGroup, enabled: boolean): void {
    props.onUpdateToolCapabilities({
      ...props.toolCapabilities,
      [group.key]: enabled,
    });
    props.onUpdateToolToggles({
      ...props.toolToggles,
      ...Object.fromEntries(group.tools.map((tool) => [tool.key, enabled])),
    } as ToolToggles);
  }

  function updateTool(group: CapabilityGroup, tool: ToolItem, enabled: boolean): void {
    const nextToolToggles = {
      ...props.toolToggles,
      [tool.key]: enabled,
    } satisfies ToolToggles;
    const enabledCount = group.tools.filter((item) =>
      item.key === tool.key ? enabled : nextToolToggles[item.key]
    ).length;
    const nextCapabilities = {
      ...props.toolCapabilities,
      [group.key]: enabledCount > 0,
    } satisfies ToolCapabilities;
    props.onUpdateToolToggles(nextToolToggles);
    props.onUpdateToolCapabilities(nextCapabilities);
  }

  function getExtensionGroupState(group: ExtensionToolGroup): ExtensionGroupState {
    const enabledCount = group.tools.filter(
      (tool) => props.extensionToolToggles[tool.key] === true
    ).length;
    return {
      checked: enabledCount === group.tools.length && group.tools.length > 0,
      indeterminate: enabledCount > 0 && enabledCount < group.tools.length,
      enabledCount,
    };
  }

  function updateExtensionGroup(group: ExtensionToolGroup, enabled: boolean): void {
    props.onUpdateExtensionToolToggles({
      ...props.extensionToolToggles,
      ...Object.fromEntries(group.tools.map((tool) => [tool.key, enabled])),
    });
  }

  function updateExtensionTool(toolKey: string, enabled: boolean): void {
    props.onUpdateExtensionToolToggles({
      ...props.extensionToolToggles,
      [toolKey]: enabled,
    });
  }

  return (
    <div className="relative" ref={props.anchorRef}>
      <button
        type="button"
        className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-transparent text-foreground transition-colors hover:bg-[rgba(255,255,255,0.15)]"
        onClick={props.onToggleOpen}
        title="Mở Configure Tools"
      >
        <SlidersHorizontal className="h-4 w-4" />
      </button>
      {props.isOpen ? (
        <div className="absolute bottom-12 left-0 z-30 w-[460px] rounded-[18px] border border-white/10 bg-[#111a2c]/95 p-2 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm font-medium text-foreground">
            <div className="flex items-center gap-2">
              <Settings2 className="h-4 w-4 text-muted-foreground" />
              <span>Configure Tools</span>
            </div>
            <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-xs text-muted-foreground">
              {selectedToolCount} Selected
            </span>
          </div>

          <div className="max-h-[420px] space-y-1 overflow-y-auto pr-1">
            <div className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Built-in
            </div>
            {CAPABILITY_GROUPS.map((group) => {
              const enabledCount = group.tools.filter(
                (tool) => props.toolToggles[tool.key]
              ).length;
              const groupChecked =
                props.toolCapabilities[group.key] && enabledCount === group.tools.length;
              const groupIndeterminate =
                enabledCount > 0 && enabledCount < group.tools.length;
              const isExpanded = expandedGroups[group.key] ?? true;

              return (
                <div
                  key={group.key}
                  className="rounded-xl border border-white/8 bg-white/[0.03]"
                >
                  <div className="grid grid-cols-[20px_20px_minmax(0,1fr)_auto] items-start gap-3 px-3 py-2">
                    <button
                      type="button"
                      className="mt-0.5 inline-flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                      onClick={() => toggleGroupExpanded(group.key)}
                      title={isExpanded ? "Thu gọn" : "Mở rộng"}
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </button>

                    <TreeCheckbox
                      checked={groupChecked}
                      indeterminate={groupIndeterminate}
                      onClick={() => updateGroup(group, !(groupChecked || groupIndeterminate))}
                      title={group.label}
                    />

                    <button
                      type="button"
                      className="min-w-0 text-left"
                      onClick={() => toggleGroupExpanded(group.key)}
                    >
                      <div className="text-sm font-medium text-foreground">
                        {group.label}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {group.description}
                      </div>
                    </button>

                    <div className="pt-0.5 text-xs text-muted-foreground">
                      {enabledCount}/{group.tools.length}
                    </div>
                  </div>

                  {isExpanded ? (
                    <div className="space-y-1 border-t border-white/8 px-3 py-2">
                      {group.tools.map((tool) => (
                        <div
                          key={tool.key}
                          className="grid grid-cols-[20px_minmax(0,1fr)] items-start gap-3 rounded-lg pl-8 pr-2 py-1.5 hover:bg-white/5"
                        >
                          <TreeCheckbox
                            checked={props.toolToggles[tool.key]}
                            onClick={() =>
                              updateTool(group, tool, !props.toolToggles[tool.key])
                            }
                            title={tool.label}
                          />
                          <div className="min-w-0">
                            <div className="text-sm text-foreground">{tool.label}</div>
                            <div className="text-xs text-muted-foreground">
                              {tool.description}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}

            {activeExtensionToolGroups.length > 0 ? (
              <>
                <div className="mt-3 px-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Activated Extension & MCP Tools
                </div>

                {activeExtensionToolGroups.map((group) => {
                  const groupState = getExtensionGroupState(group);
                  const isExpanded = expandedGroups[group.extensionId] ?? false;

                  return (
                    <div
                      key={group.extensionId}
                      className="rounded-xl border border-white/8 bg-white/[0.03]"
                    >
                      <div className="grid grid-cols-[20px_20px_minmax(0,1fr)_auto] items-start gap-3 px-3 py-2">
                        <button
                          type="button"
                          className="mt-0.5 inline-flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                          onClick={() => toggleGroupExpanded(group.extensionId)}
                          title={isExpanded ? "Thu gọn" : "Mở rộng"}
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </button>

                        <TreeCheckbox
                          checked={groupState.checked}
                          indeterminate={groupState.indeterminate}
                          onClick={() =>
                            updateExtensionGroup(
                              group,
                              !(groupState.checked || groupState.indeterminate)
                            )
                          }
                          title={group.label}
                        />

                        <button
                          type="button"
                          className="min-w-0 text-left"
                          onClick={() => toggleGroupExpanded(group.extensionId)}
                        >
                          <div className="text-sm font-medium text-foreground">
                            {group.label}
                            {group.source === "mcp_curated" ? (
                              <span className="ml-2 rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-sky-300">
                                MCP / Curated
                              </span>
                            ) : null}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {group.description}
                          </div>
                        </button>

                        <div className="pt-0.5 text-xs text-muted-foreground">
                          {groupState.enabledCount}/{group.tools.length}
                        </div>
                      </div>

                      {isExpanded ? (
                        <div className="space-y-1 border-t border-white/8 px-3 py-2">
                          {group.tools.map((tool) => (
                            <div
                              key={tool.key}
                              className="grid grid-cols-[20px_minmax(0,1fr)] items-start gap-3 rounded-lg pl-8 pr-2 py-1.5 hover:bg-white/5"
                            >
                              <TreeCheckbox
                                checked={props.extensionToolToggles[tool.key] === true}
                                onClick={() =>
                                  updateExtensionTool(
                                    tool.key,
                                    props.extensionToolToggles[tool.key] !== true
                                  )
                                }
                                title={tool.runtimeName}
                              />
                              <div className="min-w-0">
                                <div className="text-sm text-foreground">
                                  {tool.runtimeName}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  {tool.description}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
