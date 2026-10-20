# Implementation Notes

## Data Source

The extension is specific to `class.cumt.edu.cn`, inspected on 2026-10-17.
It only processes recordings available to the currently authenticated user.
It neither stores authentication tokens nor bypasses access controls or DRM.

`page-bridge.js` runs through `chrome.scripting.executeScript` in the MAIN
execution world. It accesses the existing Vue component and calls the platform's
own `$Utils.commonAjax` client, `$staticConfig` and `$md5`, using the exact
read-only detail request made by the player.

Course list component:

- Selector: `.teacher-video-resource`
- Already-loaded list: `videoInfoData`
- Semester: `currentTermInfoId`
- Selected course: `weekList`, checked against `.course-name.active`

Player component:

- Selector: `.course-video-detail`
- Current recording: `videoDetailObj`

Detail request:

```text
GET {teachingApi}/v1/videoinfo/{recordingId}
validCode = siteClient.$md5("id=" + recordingId + "&signKey=123123")
```

The site's existing authenticated request client supplies its own current
headers. No token values are copied to the extension.

The response provides:

| Field | Meaning |
| --- | --- |
| `teacherViewFiles` | Teacher camera |
| `studentViewFiles` | Student camera, intentionally not collected |
| `vgaViewFiles` | Courseware capture |
| `videoStorePath` | Actual media file path |
| `outerIp` | Media base URL used by the current player |
| `serialNum`, `startTime` | Segment ordering |
| `videoFileSize`, `fileLength` | Expected bytes and duration |

Media URLs preserve the same concatenation as the site player, including double
slashes in the pathname and query parameters. No thumbnail conversion or
resource-ID arithmetic is used. Every segment is retained, and an absent
courseware view never silently substitutes another camera.

## State And Downloads

- `core.js`: deterministic normalization, selection and Windows-safe filenames.
- `background.js`: serialized storage mutations, per-source-tab scans and shared download queue.
- `popup.html`, `popup.js`, `popup.css`: independent manager tab, not a transient popup.
- `floating-panel.js`: isolated-world site content script with a Shadow DOM launcher
  and right-hand drawer, embedding the same `popup.html` UI.
- `vendor/lucide.min.js`: locally bundled Lucide 1.59.0, license alongside it.
- Storage keys: `classReplayV2` and `classReplayV2UI`. Old guessed URLs are not imported.
- Download concurrency is 1–4 actual active browser downloads, default 2.
- Pausing stops new submissions; it does not pause active browser downloads.
- Browser `downloads.onChanged` events advance the queue.
- A one-minute extension alarm reconciles active tasks and resumes unfinished
  scans after a service worker interruption. This is recovery, not a scheduled
  download subscription.
- On worker interruption between download acceptance and ID storage, recovery
  looks for a matching recent browser download before resubmitting.
- Failed retries retain the previous ID as `retryDownloadId`. The queue first
  tries the browser's resume API and verifies the resulting state. If resume
  fails or is a no-op, it erases only the matching interrupted item before
  submitting a replacement. Cleanup failure retains the ID and blocks a new
  download. Completed or already-active items are adopted without a new request.
- Some Chromium builds' `state: "interrupted"` query matches cancelled items
  only. If the filtered erase finds nothing, the worker rechecks the exact ID,
  URL, extension owner and state before an ID/URL-only erase. `downloads.erase`
  removes a failed item's partial state; it does not delete completed files.
  `downloads.removeFile` is intentionally never used.
- Retry state survives worker interruption, including interruption immediately
  after a browser resume or before a replacement's ID has been saved. Resume is
  best-effort, not a promise of byte-level continuation.
- Extension APIs cannot enumerate arbitrary filesystem paths to remove orphaned
  fragments whose browser download records were already lost in an older version.
- Duplicate tasks are rejected by actual URL or file key while their history
  remains in the queue. Removing completed history allows downloading again.

## Current Page Synchronization

Version 2.2 adds an in-page drawer on course-list and recording-player routes.
Only `popup.html` is web-accessible, restricted to the classroom host. Scripts
and styles execute as local extension resources inside the extension-origin
iframe. The website cannot call the extension's management APIs directly.

The frame requests `panel-context` from the service worker. Its parent tab ID is
derived from Chrome's trusted message sender, not a page-supplied query string.
Embedded scan/context requests are bound to that tab, and queue/export requests
for a different source tab are rejected. The independent manager is still
available through the external-link button.

The parent uses an extension-origin, exact-frame and per-instance-channel check
for the close message. Channel generation uses `crypto.getRandomValues`, which
also works on this site's HTTP pages. Closing removes the iframe to stop its
polling; background scans and downloads continue. A runtime health check and
forced replacement on extension installation/reload avoid stale content-script
instances in already-open pages.

The manager tracks the selected source tab, not a fixed course. Opening it from
the extension action associates the clicked tab through a `sourceTab` parameter.
While the manager is visible, it checks the live page context every 1.5 seconds
and immediately on focus. Context checks do not make platform network requests.

The context contains a `sourceKey` (course, class IDs, semester, scope, and player
recording ID when applicable), the source tab ID, and a `revision` built from the
actual recording IDs. A changed context automatically replaces the visible
recording scan. Course changes reset week/search/selection filters. Unchanged
pages do not repeatedly fetch recording details.

Each source tab has its own `{course, records, scan}` catalog. A course-list
manager and a player drawer can scan concurrently without replacing each other's
records, stopping each other's jobs, or repeatedly restarting scans. Embedded
state, stop and retry requests are bound to the parent tab as well. All catalogs
share the persistent download queue and its concurrency limit. Legacy top-level
scan data is migrated into a catalog; unfinished catalogs resume independently
after worker recovery.

When the page is loading, its selected course label disagrees with the Vue model,
or its loaded records still belong to another course, context is marked loading
and old results cannot be used. Only visible page components are read.

Both queue submission and link export check the live page context again, as
well as the manager's scan ID and source identity. This closes the interval
between a course switch and the next visible manager refresh. Pending scans have
unique job IDs so late responses cannot enter a replacement course's results.

Already-submitted download tasks from earlier courses remain independent and
retain their original course folders. No video download is triggered by a course
switch or by automatic scanning.

## Release Updates

`updates.js` checks the fixed public GitHub repository's latest stable release.
Update state uses `classReplayUpdates`, separate from the video queue. Automatic
checks run at installation, startup, manager opening and a six-hour alarm, with
a persistent six-hour cache, one-hour failure backoff, a one-minute manual-check
cooldown and GitHub rate-limit backoff. Requests omit credentials and referrers
and never include classroom data. Network failures do not stop the download queue.

Version comparison is numeric, ignores drafts/prereleases, and never offers a
downgrade. Only an uploaded, nonempty `cumt-class-replay-downloader-vVERSION.zip`
asset with an exact HTTPS download URL in this repository is accepted.
Clicking Download starts a normal Edge ZIP download outside the video queue;
it does not install or run code. Users replace the original unpacked folder,
reload the extension, and refresh classroom tabs. Runtime manifest versions
are also used for floating-panel health checks.

Build a release archive with `node scripts/package-release.cjs`; output is in
the ignored `dist/` directory. The archive contains only an explicit allowlist
of extension runtime files, vendor license and the user README. The build verifies
local script references before writing it. Future releases must keep the package
filename contract and publish a stable `vVERSION` GitHub Release with that ZIP.

## Verification

Unit tests need Node.js but no npm install:

```powershell
node --test tests/core.test.js tests/background.test.js tests/page-bridge.test.js tests/updates.test.js tests/popup-updates.test.js tests/package.test.js
```

All 36 tests passed on 2026-10-18, including embedded source binding, concurrent
catalogs, source-specific export/stop/retry, shared queue behavior, legacy
state migration/recovery, resumable and nonresumable retries, browser resume
no-ops, state-filter compatibility, cleanup failure, completed-file protection
and worker interruption during retry.

Optional browser integration checks use Playwright through `NODE_PATH`, an Edge
debugging endpoint on port 9222, an already installed extension, and an already
logged-in course list. Set `REPLAY_EXTENSION_ID` to the installed extension ID.

```powershell
node tests/browser-check.cjs
node tests/media-check.cjs
node tests/course-switch-check.cjs
node tests/floating-panel-check.cjs
```

The retry check is separate and does not require login or a debugging browser:

```powershell
node tests/retry-browser-check.cjs
```

It starts an isolated headless Edge profile and a temporary loopback server.
Two 1 MB text fixtures deliberately fail mid-transfer before successful retries.
The check verifies real partial-file cleanup, a forced resume-rejection fallback,
exact output hashes, no duplicate files and preservation of completed downloads.
Normal browsing profiles, download queues and classroom videos are untouched.
It uses `REPLAY_EDGE_PATH` when set, otherwise the standard Windows Edge path.

The browser check scans the selected real course, checks view selection and week
filtering, exports a small text file, compares addresses against an open player,
samples an MP4 by HTTP range and captures desktop/mobile screenshots.

The course-switch check visits each available course, verifies automatic
re-extraction without pressing Scan, matches all recording IDs to the source
page, confirms old queue entries are preserved and rejects old-source download
and export requests. It restores the original course and does not download
videos.

The floating-panel check reloads the extension, tests course-list and player
drawers, view and week selection, link export, collapse/reopen, Esc, saved
selection, course switching, standalone management, and desktop/mobile framing.
It does not add video download tasks. It briefly plays muted source video to
verify the real player imagery before pausing it and capturing a screenshot.

`tests/download-check.cjs` is deliberately separate: it downloads the entire
first courseware file, which can be hundreds of MB. Run it only when that real
download is intended. It retains the completed file and its queue entry.

Generated verification artifacts go into the sibling folder
`edge-class-replay-downloader-qa`, not into the extension's runtime files.
