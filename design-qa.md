# Design QA — Mobile Reliability UI

## Scope and visual truth

Task 8 validates the reliability work from Tasks 1–7 in the real Codex Mobile
thread and composer surfaces. The visual comparison used:

- Desktop client reference:
  `/home/zonghangli/.codex/attachments/b6eadfe2-a765-4874-8338-f938a27a3135/codex-clipboard-8371b95f-c566-4b4f-8a69-c11656cda404.png`
  (`1662×1330` source pixels, normalized as `831×665` CSS pixels at the
  assumed 2× client capture density).
- Mobile viewport reference:
  `/home/zonghangli/.codex/attachments/2bd93373-d910-494f-80fd-184ff7c73162/757f803f38a3c018e530e1a0140775be.jpg`
  (`1179×2556` source pixels, normalized as `393×852` CSS pixels at 3×).
- Subagent-chip reference:
  `/home/zonghangli/.codex/attachments/e509694f-a999-4bae-be9b-08d396bdffcf/codex-clipboard-0e0f32d9-8aa8-4deb-aae7-7a80494b4ef5.png`
  (`1512×118` source pixels, normalized as `756×59` CSS pixels at 2×).

The originally named `IMG_2888.png` was no longer available. The desktop
client and mobile captures above were supplied as replacements. The desktop
client was treated as the component/layout truth; the mobile capture was used
for viewport density, wrapping, and overflow checks.

## Capture method

- Route type: authenticated real-thread hash route, not a mocked page. The
  concrete thread identifier is intentionally omitted from this document and
  the committed image.
- Browser: authorized Chromium via Playwright.
- Viewport: `393×852` CSS pixels.
- Device scale factor: `3` (`1179×2556` screenshot pixels).
- Input model: mobile, touch enabled, coarse pointer.
- Themes: dark and light.
- State coverage: subagent activity, completed response actions, run footer,
  composer, open Goal menu, uploaded attachment, attachment removal.
- Normalization: each reference and implementation capture was reduced to CSS
  pixels before side-by-side comparison. Full-view and focused subagent,
  actions, Goal, and attachment comparisons were inspected together.

## Persisted review evidence

- Sanitized montage:
  `docs/superpowers/qa/mobile-reliability-pass3.png`
- Montage dimensions: `2200×1875` pixels.
- SHA-256:
  `f8b7f44215f8f21a973aaee5f5acf6767262a2981f3d514a8557bfc5d74770af`
- Current capture dimensions before component cropping: `1179×2556` pixels for
  a `393×852` CSS viewport at DPR 3.
- Current focused crops at DPR 3: subagent row `1131×120`, toolbar `405×132`,
  run footer `597×102`, composer `1131×405`, Goal menu `960×552`, and
  attachment token `456×66`.
- Reference focused crops: subagent/status `652×118` from the supplied 2×
  strip, run footer `780×115` from the supplied 2× client capture, and composer
  `1131×460` from the supplied 3× mobile capture.
- Density normalization: the source and current composer are both 3×. The 2×
  subagent and footer references were assessed at CSS size against the 3×
  implementation measurements; the committed montage retains native crop
  pixels for legibility and centers each crop in an equal-width panel.
- Compared items: subagent chip/status hierarchy, run-footer shape and
  centering, mobile composer composition, coarse-pointer Fork/Copy actions,
  Goal-open dark state, dark attachment token, and dark/light composer states.
- Redaction: only component crops are retained. Task labels, response content,
  file/path text, attachment filename, and footer counts were removed with
  opaque solid fills rather than blur. No full conversation screenshot,
  concrete route identifier, browser address, or local path is embedded.
- Manual inspection: the exact committed PNG was opened at original detail
  after assembly. It contains only the UI crops and generic control/status text
  shown above; no private conversation body, task name, or path remains.

Temporary raw captures and intermediate montage files were written only under
`/tmp/task8-review-evidence` and removed after inspection.

## Findings and fixes

| Pass | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | P1 | Fork/Copy toolbar computed to `opacity: 0.01` on touch, making it effectively invisible. | Coarse-pointer styling now keeps the toolbar at full opacity. |
| 1 | P1 | The dark Goal menu rendered a white surface because scoped global-theme selectors were not present in the final CSS. | Dark Goal selectors moved to the root stylesheet. |
| 1 | P2 | Fork and Copy were only `20px` and `26px` high. | Both controls now have a `44px` touch height. |
| 2 | P2 | The intended `12px` action label was overridden by later base declarations, leaving `9px` text. | The coarse-pointer rule now follows the base action styles. |
| 2 | P2 | The dark attachment token retained the light-theme surface. | Dark attachment selectors moved to the root stylesheet. |
| 3 | — | No remaining P0, P1, or P2 visual defects. | Passed. |

Each correction was first covered by a failing wiring test, then re-run green.
The persisted Pass 3 montage confirms `P0 = 0`, `P1 = 0`, and `P2 = 0`.

## Final measurements

- Document/client/body width: `393px`; scroll width: `393px`.
- Fork: `62×44px`, `12px` label.
- Copy: `68×44px`, `12px` label.
- Action toolbar: full opacity, `44px` high.
- Subagent row: `377×40px`; chip: `179×32px`, `14/22px` type.
- Run footer: `197×34px`, centered, `14/20px` type.
- Composer: `377×135px`, `16/24px` type.
- Goal menu: `320×184px`, wholly inside the viewport, with dark zinc surface,
  border, input, and disabled action styling.
- Uploaded attachment: compact text token on the correct dark surface; removal
  detached the token from the DOM.

## Fidelity review

- Typography uses the existing system stack, including SF Pro Text, PingFang
  SC, and Segoe UI fallbacks. Density and hierarchy match the supplied client
  references after DPR normalization.
- Subagent chips retain the existing Tabler bolt and deterministic accent tone.
  This is intentional product behavior from Task 5; the reference's multiple
  category icons were not imitated with fake assets.
- The compact centered run footer follows the desktop client reference. Its
  width is content-driven because the captured thread has no numbered step.
- Composer order is attachment, Goal, combined model/effort, microphone, and
  primary action. The old fixed permission placeholder remains intentionally
  absent.
- No raster placeholder, emoji substitute, handcrafted SVG, or CSS-drawn icon
  was introduced.
- English and Chinese content both wrap without clipping or horizontal
  overflow.

## Interaction, accessibility, and runtime evidence

- Goal opens by button activation, remains within the viewport, and closes with
  Escape.
- Attachment selection used the real file chooser; removal used the accessible
  `Remove qa-evidence.png` button and was verified by DOM detachment.
- Fork/Copy are visible on coarse pointers and meet the 44px touch-target
  dimension.
- Light and dark theme captures showed readable foreground/background
  separation and no theme flash in the validated surfaces.
- Three `403` resource console messages came from historical file/attachment
  resources outside the isolated safe preview's allowed root. They did not
  affect any Task 8 target surface. The final capture reported no failed
  network requests.
- Screenshot review does not replace a screen-reader audit or instrumented
  contrast measurement; no blocking keyboard, label, clipping, or visible
  contrast issue was found in this scope.

## Final result

`passed`
