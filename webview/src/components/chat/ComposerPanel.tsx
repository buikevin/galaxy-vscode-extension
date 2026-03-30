/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-03-23
 * @modify date 2026-03-23
 * @desc Sticky composer panel rendered at the bottom of the Galaxy Code chat view.
 */

import { ChevronDown, Plus, SendHorizontal } from "lucide-react";
import { AttachmentList } from "@webview/components/chat/AttachmentList";
import { ChangeSummaryCard } from "@webview/components/chat/ChangeSummaryCard";
import { ComposerActivityBanner } from "@webview/components/chat/ComposerActivityBanner";
import { PlusMenu } from "@webview/components/chat/PlusMenu";
import { Button } from "@webview/components/ui/button";
import { Textarea } from "@webview/components/ui/textarea";
import { useComposerContext } from "@webview/context/ComposerViewContext";

/**
 * Render the sticky composer panel below the transcript.
 */
export function ComposerPanel() {
  const composer = useComposerContext();

  return (
    <>
    <div className="sticky bottom-0 mt-2 space-y-3 border-t border-[color:var(--gc-border)] bg-[linear-gradient(to_top,color-mix(in_srgb,var(--gc-bg)_96%,transparent),color-mix(in_srgb,var(--gc-bg)_82%,transparent))] px-3 pb-3 pt-3 backdrop-blur-xl max-[620px]:px-2 max-[620px]:pb-2 max-[620px]:pt-2">
      {composer.showChangeSummaryBox ? (
        <ChangeSummaryCard
          summary={composer.changeSummary}
          onKeep={composer.onKeepChanges}
          onRevertAll={composer.onRevertAll}
          onReview={composer.onReview}
          reviewFindings={composer.qualityDetails.reviewFindings}
          onDismissReviewFinding={composer.onDismissReviewFinding}
          onApplyReviewFinding={composer.onApplyReviewFinding}
        />
      ) : null}

      <AttachmentList
        figmaAttachments={composer.figmaAttachments}
        localAttachments={composer.localAttachments}
        onOpenFigmaPreview={composer.onOpenFigmaPreview}
        onRemoveFigmaAttachment={composer.onRemoveFigmaAttachment}
        onOpenLocalPreview={composer.onOpenLocalPreview}
        onRemoveLocalAttachment={composer.onRemoveLocalAttachment}
      />

      {composer.isRunning && composer.activityLabel ? (
        <ComposerActivityBanner label={composer.activityLabel} />
      ) : null}

      <div className="rounded-2xl border border-[color:var(--gc-border)] bg-[var(--gc-surface-elevated)] p-3 shadow-[0_16px_40px_rgba(0,0,0,0.22)] max-[620px]:rounded-xl max-[620px]:p-2.5">
        <Textarea
          ref={composer.textareaRef}
          placeholder="Hỏi Galaxy Code..."
          value={composer.input}
          onChange={composer.onInputChange}
          onPaste={composer.onPaste}
          onKeyDown={composer.onKeyDown}
          rows={1}
          className="h-10 min-h-[40px] overflow-hidden resize-none border-0 bg-transparent px-0 py-1 text-[13px] leading-7 text-[color:var(--gc-foreground)] shadow-none outline-none ring-0 placeholder:text-[color:var(--gc-muted)] focus-visible:ring-0"
        />

      {composer.slashCommands.length > 0 ? (
        <div className="mt-2 rounded-xl border border-[color:var(--gc-border)] bg-[var(--gc-surface)] p-2">
          <div className="space-y-1">
            {composer.slashCommands.map((command) => (
              <button
                key={command.id}
                type="button"
                className="flex w-full items-start justify-between rounded-xl px-3 py-2 text-left transition-colors hover:bg-[var(--gc-surface-elevated)]"
                onClick={() => composer.onExecuteSlashCommand(command.id)}
              >
                <div>
                  <div className="text-sm font-medium text-[color:var(--gc-foreground)]">
                    {command.label}
                  </div>
                  <div className="text-xs text-[color:var(--gc-muted)]">
                    {command.description}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-[color:var(--gc-border)] pt-3 max-[520px]:flex-wrap max-[520px]:items-start">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <button
            type="button"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-transparent text-[color:var(--gc-foreground)] transition-colors hover:bg-[var(--gc-surface)]"
            title="Thêm ảnh và file"
            onClick={composer.onOpenFilePicker}
          >
            <Plus className="h-4 w-4" />
          </button>
          <input
            ref={composer.fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={composer.onFileSelection}
          />
          <div className="relative w-[clamp(92px,30vw,116px)] min-w-[92px]">
            <select
              value={composer.selectedAgent}
              onChange={(event) =>
                composer.onSelectedAgentChange(event.target.value as typeof composer.selectedAgent)
              }
              className="h-10 w-full appearance-none rounded-2xl border border-[color:var(--gc-border)] bg-[var(--gc-surface)] px-4 pr-10 text-sm text-[color:var(--gc-foreground)] outline-none transition-colors hover:bg-[var(--gc-surface-elevated)] focus:bg-[var(--gc-surface-elevated)]"
            >
              {composer.agents.map((agent:string) => (
                <option key={agent} value={agent}>
                  {agent}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 pointer-events-none text-[color:var(--gc-muted)]" />
          </div>
        </div>
        <div className="flex items-center gap-2 max-[520px]:ml-auto">
          <Button
            onClick={composer.onSend}
            disabled={!composer.canSend || composer.isRunning}
            size="icon"
            className="shrink-0 rounded-full border border-[color:var(--gc-accent)]/30 bg-[var(--gc-accent-soft)] text-[color:var(--gc-accent)] hover:opacity-90"
          >
            <SendHorizontal className="w-4 h-4" />
          </Button>
        </div>
      </div>
      </div>

    </div>
     <div className="px-3 pb-3 max-[620px]:px-2 max-[620px]:pb-2">
       <div className="flex items-center gap-2 max-[520px]:flex-wrap">

          <div className="relative w-[clamp(140px,46vw,176px)] min-w-[140px]">
            <select
              value={
                composer.qualityPreferences.fullAccessEnabled
                  ? "full"
                  : "default"
              }
              onChange={(event) =>
                composer.onUpdateQualityPreferences({
                  ...composer.qualityPreferences,
                  fullAccessEnabled: event.target.value === "full",
                })
              }
              className="h-10 w-full appearance-none rounded-2xl border border-[color:var(--gc-border)] bg-[var(--gc-surface)] px-4 pr-10 text-sm text-[color:var(--gc-foreground)] outline-none transition-colors hover:bg-[var(--gc-surface-elevated)] focus:bg-[var(--gc-surface-elevated)]"
            >
              <option value="default">Quyền mặc định</option>
              <option value="full">Toàn quyền</option>
            </select>
            <ChevronDown className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 pointer-events-none text-[color:var(--gc-muted)]" />
          </div>
          <PlusMenu
            anchorRef={composer.plusMenuAnchorRef}
            isOpen={composer.isPlusMenuOpen}
            toolCapabilities={composer.toolCapabilities}
            toolToggles={composer.toolToggles}
            extensionToolGroups={composer.extensionToolGroups}
            extensionToolToggles={composer.extensionToolToggles}
            onToggleOpen={composer.onTogglePlusMenu}
            onUpdateToolCapabilities={composer.onUpdateToolCapabilities}
            onUpdateToolToggles={composer.onUpdateToolToggles}
            onUpdateExtensionToolToggles={composer.onUpdateExtensionToolToggles}
          />
      </div>
     </div>
    </>
  );
}
