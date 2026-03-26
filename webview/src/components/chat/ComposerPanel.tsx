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
    <div className="sticky bottom-0 mt-auto space-y-2 rounded-[20px] border border-white/10 bg-white/5 p-2.5 shadow-[0_16px_40px_rgba(0,0,0,0.28)] backdrop-blur-xl">
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

      <Textarea
        ref={composer.textareaRef}
        placeholder="Ask Galaxy Code..."
        value={composer.input}
        onChange={composer.onInputChange}
        onPaste={composer.onPaste}
        onKeyDown={composer.onKeyDown}
        rows={1}
        className="h-10 min-h-[40px] overflow-hidden resize-none border-0 bg-transparent px-0 py-2 text-sm leading-6 shadow-none outline-none ring-0 focus-visible:ring-0"
      />

      {composer.slashCommands.length > 0 ? (
        <div className="rounded-2xl border border-white/10 bg-[#111a2c]/95 p-2 shadow-2xl backdrop-blur-xl">
          <div className="space-y-1">
            {composer.slashCommands.map((command) => (
              <button
                key={command.id}
                type="button"
                className="flex items-start justify-between w-full px-3 py-2 text-left transition-colors rounded-xl hover:bg-white/5"
                onClick={() => composer.onExecuteSlashCommand(command.id)}
              >
                <div>
                  <div className="text-sm font-medium text-foreground">
                    {command.label}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {command.description}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-transparent text-foreground transition-colors hover:bg-[rgba(255,255,255,0.15)]"
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
          <div className="relative w-[176px]">
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
              className="h-10 w-full appearance-none rounded-[16px] bg-transparent px-4 pr-10 text-sm text-foreground outline-none transition-colors hover:bg-[rgba(255,255,255,0.15)] focus:bg-[rgba(255,255,255,0.12)]"
            >
              <option value="default">Default permission</option>
              <option value="full">Full access</option>
            </select>
            <ChevronDown className="absolute w-4 h-4 -translate-y-1/2 pointer-events-none right-3 top-1/2 text-muted-foreground" />
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
          <div className="relative w-[116px]">
            <select
              value={composer.selectedAgent}
              onChange={(event) =>
                composer.onSelectedAgentChange(event.target.value as typeof composer.selectedAgent)
              }
              className="h-10 w-full appearance-none rounded-[16px] bg-transparent px-4 pr-10 text-base text-foreground outline-none transition-colors hover:bg-[rgba(255,255,255,0.15)] focus:bg-[rgba(255,255,255,0.12)]"
            >
              {composer.agents.map((agent) => (
                <option key={agent} value={agent}>
                  {agent}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute w-4 h-4 -translate-y-1/2 pointer-events-none right-3 top-1/2 text-muted-foreground" />
          </div>
          <div
            className="relative flex items-center justify-center w-10 h-10 rounded-full shrink-0"
            style={{
              background: `conic-gradient(rgb(56 189 248) ${composer.tokenUsageDegrees}deg, rgba(255,255,255,0.1) ${composer.tokenUsageDegrees}deg 360deg)`,
            }}
            title={`${composer.promptTokens} / ${composer.maxContextTokens} tokens`}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#1e293b] text-[10px] font-semibold text-foreground">
              {`${composer.tokenUsagePercent}%`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={composer.onSend}
            disabled={!composer.canSend || composer.isRunning}
            size="icon"
            className="shrink-0"
          >
            <SendHorizontal className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
