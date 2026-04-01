/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared base component profile entities used by the extension runtime.
 */

/** Known component-library baselines that the UI generator can target safely. */
export type BaseComponentLibrary =
  | 'galaxy-design'
  | 'shadcn-ui'
  | 'antd'
  | 'mui'
  | 'chakra-ui'
  | 'radix-custom'
  | 'unknown';

/** Confidence levels describing how reliable the detected base component profile is. */
export type BaseComponentProfileConfidence = 'high' | 'medium' | 'low';

/** Structured result describing the likely base component system of a workspace. */
export type BaseComponentProfile = Readonly<{
  /** Detected component library or design-system family. */
  library: BaseComponentLibrary;
  /** Confidence assigned to the detection result. */
  confidence: BaseComponentProfileConfidence;
  /** Concrete evidence items that justify the classification. */
  evidence: readonly string[];
  /** Guidance lines injected into prompts to steer edits toward the detected system. */
  guidance: readonly string[];
}>;
