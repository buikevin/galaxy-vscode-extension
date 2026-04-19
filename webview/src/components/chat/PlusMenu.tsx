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
  X,
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
    label: "Đọc dự án",
    description: "Đọc file, tài liệu và cấu trúc workspace.",
    tools: [
      { key: "read_file", label: "Đọc file", description: "Đọc nội dung file theo vùng dòng." },
      { key: "find_test_files", label: "Tìm file test", description: "Tìm file test hoặc source liên quan." },
      { key: "get_latest_test_failure", label: "Lỗi test gần nhất", description: "Lấy lỗi test gần nhất đã lưu." },
      { key: "get_latest_review_findings", label: "Review findings gần nhất", description: "Lấy kết quả review gần nhất đã lưu." },
      { key: "get_next_review_finding", label: "Finding review tiếp theo", description: "Lấy finding review tiếp theo chưa bỏ qua." },
      { key: "dismiss_review_finding", label: "Bỏ qua finding review", description: "Ẩn một review finding theo id." },
      { key: "read_document", label: "Đọc tài liệu", description: "Đọc tài liệu như docx hoặc pdf theo từng phần." },
      { key: "grep", label: "Tìm nội dung", description: "Tìm text hoặc symbol theo pattern." },
      { key: "list_dir", label: "Quét thư mục", description: "Liệt kê cây thư mục và file." },
      { key: "head", label: "Xem đầu file", description: "Xem nhanh phần đầu file." },
      { key: "tail", label: "Xem cuối file", description: "Xem nhanh phần cuối file." },
    ],
  },
  {
    key: "editFiles",
    label: "Sửa file",
    description: "Cho phép agent sửa hoặc tạo file.",
    tools: [
      { key: "insert_file_at_line", label: "Chèn vào file", description: "Chèn nội dung vào trước một dòng cụ thể." },
      { key: "edit_file_range", label: "Sửa một vùng file", description: "Chỉnh sửa đúng một vùng dòng." },
      { key: "multi_edit_file_ranges", label: "Sửa nhiều vùng", description: "Chỉnh sửa nhiều vùng dòng trong cùng một file." },
      { key: "write_file", label: "Tạo file mới", description: "Chỉ tạo file mới, không ghi đè file đã tồn tại." },
    ],
  },
  {
    key: "runCommands",
    label: "Chạy lệnh",
    description: "Cho phép agent chạy command trong terminal.",
    tools: [
      { key: "git_status", label: "Git status", description: "Đọc trạng thái working tree Git." },
      { key: "git_diff", label: "Git diff", description: "Đọc thay đổi staged hoặc unstaged." },
      { key: "git_add", label: "Git add", description: "Stage file hoặc thư mục." },
      { key: "git_commit", label: "Git commit", description: "Tạo commit với message cụ thể." },
      { key: "git_push", label: "Git push", description: "Đẩy branch hiện tại hoặc branch chỉ định." },
      { key: "git_pull", label: "Git pull", description: "Kéo thay đổi mới từ remote." },
      { key: "git_checkout", label: "Git checkout", description: "Chuyển branch/ref hoặc tạo branch mới." },
      { key: "run_terminal_command", label: "Chạy lệnh mới", description: "Tạo command terminal mới." },
      { key: "await_terminal_command", label: "Chờ lệnh hoàn tất", description: "Chờ command nền hoàn thành." },
      { key: "get_terminal_output", label: "Lấy output terminal", description: "Lấy output của command đã chạy." },
      { key: "kill_terminal_command", label: "Dừng lệnh", description: "Dừng command terminal đang chạy." },
      { key: "run_project_command", label: "Chạy lệnh dự án", description: "Giữ tương thích với flow cũ." },
    ],
  },
  {
    key: "webResearch",
    label: "Nghiên cứu web",
    description: "Tìm tài liệu lập trình và đọc nội dung web.",
    tools: [
      { key: "search_web", label: "Tìm trên web", description: "Tìm kiếm web." },
      { key: "extract_web", label: "Đọc trang web", description: "Đọc nội dung chính của trang web." },
      { key: "map_web", label: "Sơ đồ website", description: "Lập sơ đồ cấu trúc website." },
      { key: "crawl_web", label: "Quét website", description: "Quét website theo phạm vi cho phép." },
    ],
  },
  {
    key: "validation",
    label: "Kiểm tra",
    description: "Chạy validate phù hợp với dự án trước khi chốt.",
    tools: [
      { key: "validate_code", label: "Validate code", description: "Chọn validator theo ngôn ngữ và loại dự án." },
    ],
  },
  {
    key: "review",
    label: "Review",
    description: "Chạy code review ở cuối pha làm việc trước khi chốt.",
    tools: [
      { key: "request_code_review", label: "Code review", description: "Chạy reviewer ở cuối pha làm việc." },
    ],
  },
  {
    key: "vscodeNative",
    label: "VS Code",
    description: "Dùng diff, search, problems và các khả năng native khác.",
    tools: [
      { key: "vscode_open_diff", label: "Mở diff", description: "Mở diff editor native." },
      { key: "vscode_start_frontend_preview", label: "Khởi động frontend preview", description: "Tự dò app frontend, chạy dev server và mở localhost preview." },
      { key: "vscode_show_problems", label: "Mở Problems", description: "Mở Problems panel." },
      { key: "vscode_workspace_search", label: "Tìm trong workspace", description: "Tìm bằng native search của VS Code." },
      { key: "vscode_find_references", label: "Tìm references", description: "Tìm references native của VS Code." },
      { key: "search_extension_tools", label: "Tìm extension tools", description: "Tìm trong danh mục extension tools đã cài." },
      { key: "activate_extension_tools", label: "Bật extension tools", description: "Bật extension tools đã tìm thấy để dùng ở các lượt sau." },
    ],
  },
  {
    key: "galaxyDesign",
    label: "Galaxy Design",
    description: "Cho phép agent dùng các tool Galaxy Design.",
    tools: [
      { key: "galaxy_design_project_info", label: "Phân tích dự án", description: "Phân tích project hiện tại." },
      { key: "galaxy_design_registry", label: "Tra cứu registry", description: "Tra cứu registry và component." },
      { key: "galaxy_design_init", label: "Khởi tạo Galaxy Design", description: "Khởi tạo Galaxy Design." },
      { key: "galaxy_design_add", label: "Thêm component", description: "Thêm component Galaxy Design." },
    ],
  },
] as const;

function CheckboxIndicator(props: Readonly<{ checked: boolean; indeterminate?: boolean }>) {
  return (
    <span
      className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
        props.checked || props.indeterminate
          ? "border-[color:var(--gc-accent)] bg-[var(--gc-accent-soft)] text-[color:var(--gc-accent)]"
          : "border-[color:var(--gc-border)] bg-transparent text-transparent"
      }`}
    >
      {props.indeterminate ? (
        <span className="h-0.5 w-2 rounded-full bg-[color:var(--gc-accent)]" />
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
      className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-[color:var(--gc-border)] bg-[var(--gc-surface)] text-[color:var(--gc-foreground)] transition-colors hover:bg-[var(--gc-surface-elevated)]"
      onClick={props.onToggleOpen}
      title="Mở cấu hình công cụ"
      >
        <SlidersHorizontal className="h-4 w-4" />
      </button>
      {props.isOpen ? (
        <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]">
          <div className="absolute inset-x-3 bottom-3 top-3 mx-auto flex max-w-[760px] min-w-0 flex-col overflow-hidden rounded-[18px] border border-[color:var(--gc-border)] bg-[color:color-mix(in_srgb,var(--gc-bg)_94%,transparent)] shadow-2xl backdrop-blur-xl">
            <div className="flex items-center justify-between gap-3 border-b border-[color:var(--gc-border)] px-4 py-3 text-sm font-medium text-[color:var(--gc-foreground)]">
              <div className="flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-[color:var(--gc-muted)]" />
                <span>Cấu hình công cụ</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full border border-[color:var(--gc-border)] bg-[var(--gc-surface)] px-2.5 py-0.5 text-xs text-[color:var(--gc-muted)]">
                  {selectedToolCount} đã bật
                </span>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[color:var(--gc-muted)] transition-colors hover:bg-[var(--gc-surface)] hover:text-[color:var(--gc-foreground)]"
                  onClick={props.onToggleOpen}
                  title="Đóng cấu hình công cụ"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              <div className="space-y-1">
                <div className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--gc-muted)]">
                  Tích hợp sẵn
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
                      className="rounded-xl border border-[color:var(--gc-border)] bg-[var(--gc-surface)]"
                    >
                      <div className="grid grid-cols-[20px_20px_minmax(0,1fr)_auto] items-start gap-3 px-3 py-2">
                        <button
                          type="button"
                          className="mt-0.5 inline-flex h-5 w-5 items-center justify-center text-[color:var(--gc-muted)] transition-colors hover:text-[color:var(--gc-foreground)]"
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
                          <div className="text-sm font-medium text-[color:var(--gc-foreground)]">
                            {group.label}
                          </div>
                          <div className="text-xs text-[color:var(--gc-muted)]">
                            {group.description}
                          </div>
                        </button>

                        <div className="pt-0.5 text-xs text-[color:var(--gc-muted)]">
                          {enabledCount}/{group.tools.length}
                        </div>
                      </div>

                      {isExpanded ? (
                        <div className="space-y-1 border-t border-[color:var(--gc-border)] px-3 py-2">
                          {group.tools.map((tool) => (
                            <div
                              key={tool.key}
                              className="grid grid-cols-[20px_minmax(0,1fr)] items-start gap-3 rounded-lg py-1.5 pl-8 pr-2 hover:bg-[var(--gc-surface-elevated)]"
                            >
                              <TreeCheckbox
                                checked={props.toolToggles[tool.key]}
                                onClick={() =>
                                  updateTool(group, tool, !props.toolToggles[tool.key])
                                }
                                title={tool.label}
                              />
                              <div className="min-w-0">
                                <div className="text-sm text-[color:var(--gc-foreground)]">{tool.label}</div>
                                <div className="text-xs text-[color:var(--gc-muted)]">
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
                    <div className="mt-3 px-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--gc-muted)]">
                      Extension và MCP đang bật
                    </div>

                    {activeExtensionToolGroups.map((group) => {
                      const groupState = getExtensionGroupState(group);
                      const isExpanded = expandedGroups[group.extensionId] ?? false;

                      return (
                        <div
                          key={group.extensionId}
                          className="rounded-xl border border-[color:var(--gc-border)] bg-[var(--gc-surface)]"
                        >
                          <div className="grid grid-cols-[20px_20px_minmax(0,1fr)_auto] items-start gap-3 px-3 py-2">
                            <button
                              type="button"
                              className="mt-0.5 inline-flex h-5 w-5 items-center justify-center text-[color:var(--gc-muted)] transition-colors hover:text-[color:var(--gc-foreground)]"
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
                              <div className="text-sm font-medium text-[color:var(--gc-foreground)]">
                                {group.label}
                                {group.source === "mcp_curated" ? (
                                  <span className="ml-2 rounded-full border border-[color:var(--gc-accent)]/30 bg-[var(--gc-accent-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--gc-accent)]">
                                    MCP / Curated
                                  </span>
                                ) : null}
                              </div>
                              <div className="text-xs text-[color:var(--gc-muted)]">
                                {group.description}
                              </div>
                            </button>

                            <div className="pt-0.5 text-xs text-[color:var(--gc-muted)]">
                              {groupState.enabledCount}/{group.tools.length}
                            </div>
                          </div>

                          {isExpanded ? (
                            <div className="space-y-1 border-t border-[color:var(--gc-border)] px-3 py-2">
                              {group.tools.map((tool) => (
                                <div
                                  key={tool.key}
                                  className="grid grid-cols-[20px_minmax(0,1fr)] items-start gap-3 rounded-lg py-1.5 pl-8 pr-2 hover:bg-[var(--gc-surface-elevated)]"
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
                                    <div className="text-sm text-[color:var(--gc-foreground)]">
                                      {tool.runtimeName}
                                    </div>
                                    <div className="text-xs text-[color:var(--gc-muted)]">
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
          </div>
        </div>
      ) : null}
    </div>
  );
}
