### Feature: External client running state after refresh

#### Prerequisites
- Use a Linux host where both Codex Mobile instances run under the same user and read the same Codex home/session data.
- Start two Codex Mobile app instances backed by different Codex app-server processes: Client A in a desktop browser and Client B in a mobile browser or mobile viewport.
- Open the same existing thread in both clients and ensure it is idle before starting.
- Prepare a prompt in Client A that runs long enough to refresh and inspect Client B before it completes.
- Configure Client A to queue messages while busy, and prepare a short test-only follow-up that will become the visible queued row before Client B takes external ownership.
- Ensure Client B can be tested at both `375x812` and `768x1024` and can switch explicitly between Light and Dark appearance.

#### Steps
1. In desktop Client A, submit the long-running prompt, confirm the turn begins streaming, submit the prepared follow-up in Queue mode, and confirm at least one queued row is visible before opening or refreshing the thread in Client B.
2. In desktop Client A, refresh the browser page while the turn is still running, reopen the thread if necessary, and inspect its sidebar row, conversation, composer, enabled local stop control, and queued row.
3. Set Client B to a `375x812` viewport and Light appearance, navigate to the same thread, and refresh while Client A's turn and queued row are still active.
4. In Client B at `375x812` Light, read and scroll the conversation, then try to focus or edit the composer, add an attachment, change plan/model/reasoning/speed settings, submit with the button and configured send shortcut, activate the stop control, edit a prior user prompt (rollback), undo/redo prior file changes, answer any pending server request, and edit, steer, delete, drag, or reorder the queued row.
5. Switch Client B to Dark appearance without changing the `375x812` viewport and repeat the visual and disabled-control checks.
6. Resize Client B to `768x1024` while keeping Dark appearance, refresh the same thread, and repeat the visual and disabled-control checks; then switch to Light appearance at `768x1024` and repeat them once more.
7. Leave both clients open until the turn reaches a terminal state in Client A. Immediately after the external-runtime poll notices completion but before terminal output appears, try to submit once in Client B; then wait for the forced terminal detail refresh to finish.
8. In Client B, confirm the final output appears, the sidebar and composer leave their running state, and submit a short follow-up message.
9. While an external-runtime request for one selected thread is deliberately left pending (for example with a development request interceptor), select a second externally running thread and wait one polling interval; then stop polling or trigger a local turn on the selected thread.
10. Create one pending request scoped to an externally owned thread and one scoped to an idle thread. Change selection before responding to each request, and also exercise one explicitly global request plus an expired/unknown request ID.

#### Expected Results
- During both refreshes, the thread remains selected and its readable conversation history stays visible.
- The selected thread's sidebar row shows the running spinner while the external turn is active.
- Client B shows a stop-shaped control labelled and titled `Running in another client`; it is disabled and cannot emit an interrupt.
- Client B's composer text, attachment, configuration, model, reasoning, speed, submit, dictation, and keyboard-send paths are disabled while external ownership is active.
- Every queued edit, steer, delete, drag, drop, and reorder control is disabled in Client B, with no queue mutation.
- Prior-message rollback/edit, file-change undo/redo, plan implementation, and pending-request response controls are hidden or disabled in Client B, and their RPCs are not sent.
- Client B does not drain the persisted queued follow-up while Client A still owns the external turn, including after Client B startup/recovery; inconclusive Linux ownership checks keep the queue blocked and retry later.
- Client A retains its enabled local stop control, and an idle composer still retains normal send behavior.
- Client B retains the external read-only lease until the forced terminal detail refresh has succeeded, so the immediate completion-edge submit cannot start a duplicate turn.
- Changing selection, stopping/disconnecting, or observing a local takeover aborts the obsolete runtime request; the newly selected external thread starts its own poll after two seconds, and a late completion from the old request cannot clear or reschedule the new poll.
- Pending responses are authorized by the request ID's recorded scope rather than the selected row: external-thread requests remain blocked after selection changes, idle/local requests remain usable, explicit global requests retain their prior behavior, and unknown/expired IDs send no RPC.
- After the external turn reaches a terminal state, Client B removes the sidebar spinner, refreshes the completed conversation, replaces the disabled stop control with the normal idle send control, re-enables queue/composer interactions, and sends the follow-up normally.
- The layout remains usable in Light and Dark appearance at both `375x812` and `768x1024`, with the composer and queue actions remaining visible and correctly disabled.

#### Configured desktop command and launcher descendants

##### Prerequisites and evidence helpers
- Run this procedure in a disposable test thread on Linux, as the same unprivileged user that owns `codex-mobile-safe.service`. Do not use `sudo`, a production thread, or a password literal in any command.
- Run the commands below in one dedicated Bash shell. Export the test thread ID, locate its single canonical rollout, and create temporary evidence files:

  ```bash
  set -euo pipefail
  umask 077
  export THREAD_ID='<test-thread-id>'
  SERVICE_URL='http://127.0.0.1:5900'
  PROC_ROOT='/proc'
  SESSIONS_ROOT="$(realpath "${CODEX_HOME:-$HOME/.codex}/sessions")"
  mapfile -t ROLLOUT_MATCHES < <(find "$SESSIONS_ROOT" -type f -name "rollout-*-${THREAD_ID}.jsonl" -print)
  ((${#ROLLOUT_MATCHES[@]} == 1)) || { printf 'expected one rollout, found %s\n' "${#ROLLOUT_MATCHES[@]}" >&2; exit 1; }
  ROLLOUT="$(realpath "${ROLLOUT_MATCHES[0]}")"
  ROLLOUT_IDENTITY="$(stat -Lc '%d:%i' "$ROLLOUT")"
  EVIDENCE_DIR="$(mktemp -d)"
  COOKIE_JAR="$EVIDENCE_DIR/cookies"
  cleanup_runtime_evidence() {
    unset CODEX_MOBILE_PASSWORD
    rm -f -- "$EVIDENCE_DIR/cookies" "$EVIDENCE_DIR/"*.cmdline "$EVIDENCE_DIR/"*.json
    rmdir -- "$EVIDENCE_DIR"
  }
  trap cleanup_runtime_evidence EXIT
  printf 'thread=%s\nrollout=%s\ndev:ino=%s\n' "$THREAD_ID" "$ROLLOUT" "$ROLLOUT_IDENTITY"
  ```

- Define helpers that preserve argv token boundaries, validate PID identity with `/proc/<pid>/stat` field 22, walk PPID links, and accept only a writable positive-position FD whose dev/ino matches the selected rollout:

  ```bash
  proc_starttime() {
    local stat_line tail
    IFS= read -r stat_line < "$PROC_ROOT/$1/stat" || return 1
    tail="${stat_line##*) }"
    set -- $tail
    [[ ${20:-} =~ ^[0-9]+$ ]] || return 1
    printf '%s\n' "${20}"
  }

  proc_ppid() {
    awk '$1 == "PPid:" { print $2; found=1; exit } END { if (!found) exit 1 }' \
      "$PROC_ROOT/$1/status" 2>/dev/null
  }

  print_argv() {
    local pid="$1" index=0 arg
    while IFS= read -r -d '' arg; do
      printf 'pid=%s argv[%s]=%q\n' "$pid" "$index" "$arg"
      ((index += 1))
    done < "$PROC_ROOT/$pid/cmdline"
  }

  is_codex_app_server() {
    local pid="$1" saw_codex=0 arg
    while IFS= read -r -d '' arg; do
      if ((saw_codex)) && [[ $arg == app-server ]]; then return 0; fi
      [[ ${arg##*/} == codex ]] && saw_codex=1
    done < "$PROC_ROOT/$pid/cmdline" 2>/dev/null
    return 1
  }

  has_argv_token() {
    local pid="$1" expected="$2" arg
    while IFS= read -r -d '' arg; do
      [[ $arg == "$expected" ]] && return 0
    done < "$PROC_ROOT/$pid/cmdline" 2>/dev/null
    return 1
  }

  classify_ancestry() {
    local current="$1" root="$2" depth parent
    local -A seen=()
    [[ $current =~ ^[0-9]+$ && $root =~ ^[0-9]+$ ]] || return 2
    for ((depth = 0; depth < 128; depth += 1)); do
      [[ $current == "$root" ]] && return 0
      ((current == 1)) && return 1
      [[ -z ${seen[$current]+present} ]] || return 2
      seen[$current]=1
      parent="$(proc_ppid "$current")" || return 2
      [[ $parent =~ ^[0-9]+$ ]] || return 2
      ((parent == 0)) && return 1
      current="$parent"
    done
    return 2
  }

  assert_descendant_of() {
    local result
    if classify_ancestry "$1" "$2"; then return 0; else result=$?; fi
    return "$result"
  }

  assert_not_descendant_of() {
    local result
    if classify_ancestry "$1" "$2"; then
      return 1
    else
      result=$?
    fi
    if [[ $result == 1 ]]; then return 0; fi
    return 2
  }

  show_ppid_chain() {
    local current="$1" depth parent starttime
    local -A seen=()
    for ((depth = 0; depth < 128; depth += 1)); do
      [[ $current =~ ^[0-9]+$ ]] || return 1
      [[ -z ${seen[$current]+present} ]] || return 1
      seen[$current]=1
      starttime="$(proc_starttime "$current")" || return 1
      parent="$(proc_ppid "$current")" || return 1
      printf 'pid=%s ppid=%s starttime=%s\n' "$current" "$parent" "$starttime"
      print_argv "$current" || return 1
      [[ $current == 1 || $parent == 0 ]] && return 0
      [[ $parent =~ ^[0-9]+$ ]] || return 1
      current="$parent"
    done
    return 1
  }

  rollout_writer_fds() {
    local pid="$1" fd info position flags access found=1
    for fd in "$PROC_ROOT/$pid/fd/"[0-9]*; do
      [[ -e $fd ]] || continue
      [[ $(stat -Lc '%d:%i' "$fd" 2>/dev/null) == "$ROLLOUT_IDENTITY" ]] || continue
      info="$PROC_ROOT/$pid/fdinfo/${fd##*/}"
      position="$(awk '$1 == "pos:" { print $2; exit }' "$info" 2>/dev/null)"
      flags="$(awk '$1 == "flags:" { print $2; exit }' "$info" 2>/dev/null)"
      [[ $position =~ ^[0-9]+$ && $flags =~ ^[0-7]+$ ]] || continue
      access=$(( (8#$flags) & 3 ))
      printf 'pid=%s fd=%s pos=%s flags=%s target=%s\n' \
        "$pid" "${fd##*/}" "$position" "$flags" "$(readlink "$fd")"
      if ((position > 0 && (access == 1 || access == 2))); then found=0; fi
    done
    return "$found"
  }
  ```

##### Steps
1. Start or select a disposable desktop Client A whose app-server is launched in the production argv layout `codex -c features.code_mode_host=true app-server --listen unix://`. A bare app-server without its desktop JSON-RPC client cannot drive this check. In Client A, open `THREAD_ID`, submit a test-only prompt such as “run `sleep 300`, then report completion,” and confirm the turn is still running. Open the same thread in `codex-mobile-safe` so its own app-server resumes the rollout.
2. Record the mobile service launcher directly from systemd, then enumerate qualifying processes that currently hold the exact rollout as a writable, positive-position FD:

   ```bash
   [[ $(systemctl --user show codex-mobile-safe.service -p ActiveState --value) == active ]] || exit 1
   MOBILE_LAUNCHER_PID="$(systemctl --user show codex-mobile-safe.service -p MainPID --value)"
   [[ $MOBILE_LAUNCHER_PID =~ ^[0-9]+$ ]] && ((MOBILE_LAUNCHER_PID > 1)) || exit 1

   mapfile -t WRITER_PIDS < <(
     for proc_dir in "$PROC_ROOT/"[0-9]*; do
       pid="${proc_dir##*/}"
       if is_codex_app_server "$pid" && rollout_writer_fds "$pid" >/dev/null; then printf '%s\n' "$pid"; fi
     done
   )

   MOBILE_WRITER_PIDS=()
   DESKTOP_CANDIDATES=()
   for pid in "${WRITER_PIDS[@]}"; do
     if classify_ancestry "$pid" "$MOBILE_LAUNCHER_PID"; then
       MOBILE_WRITER_PIDS+=("$pid")
     else
       ancestry_result=$?
       if [[ $ancestry_result == 1 ]]; then
         if has_argv_token "$pid" 'features.code_mode_host=true' \
           && has_argv_token "$pid" app-server \
           && has_argv_token "$pid" --listen \
           && has_argv_token "$pid" 'unix://'; then
           DESKTOP_CANDIDATES+=("$pid")
         fi
       else
         printf 'cannot validate ancestry for writer pid=%s\n' "$pid" >&2
         exit 1
       fi
     fi
   done

   MOBILE_NATIVE_CANDIDATES=()
   for pid in "${MOBILE_WRITER_PIDS[@]}"; do
     argv0="$(tr '\0' '\n' < "$PROC_ROOT/$pid/cmdline" | head -n 1)"
     [[ ${argv0##*/} == codex ]] && MOBILE_NATIVE_CANDIDATES+=("$pid")
   done
   ((${#MOBILE_NATIVE_CANDIDATES[@]} == 1)) || { printf 'ambiguous mobile native writers\n' >&2; exit 1; }
   ((${#DESKTOP_CANDIDATES[@]} == 1)) || { printf 'ambiguous desktop writers\n' >&2; exit 1; }
   MOBILE_NATIVE_PID="${MOBILE_NATIVE_CANDIDATES[0]}"
   DESKTOP_PID="${DESKTOP_CANDIDATES[0]}"
   ```

3. Capture PID identities and raw argv before changing any process. Inspect the complete native-child PPID chain and verify it reaches `MOBILE_LAUNCHER_PID`; inspect both matching rollout FDs. The desktop chain must not reach the mobile launcher.

   ```bash
   MOBILE_LAUNCHER_STARTTIME="$(proc_starttime "$MOBILE_LAUNCHER_PID")"
   MOBILE_NATIVE_STARTTIME="$(proc_starttime "$MOBILE_NATIVE_PID")"
   DESKTOP_STARTTIME="$(proc_starttime "$DESKTOP_PID")"
   [[ $MOBILE_LAUNCHER_STARTTIME =~ ^[0-9]+$ ]] || exit 1
   [[ $MOBILE_NATIVE_STARTTIME =~ ^[0-9]+$ ]] || exit 1
   [[ $DESKTOP_STARTTIME =~ ^[0-9]+$ ]] || exit 1
   cp "$PROC_ROOT/$MOBILE_LAUNCHER_PID/cmdline" "$EVIDENCE_DIR/mobile-launcher.cmdline" || exit 1
   cp "$PROC_ROOT/$MOBILE_NATIVE_PID/cmdline" "$EVIDENCE_DIR/mobile-native.cmdline" || exit 1
   cp "$PROC_ROOT/$DESKTOP_PID/cmdline" "$EVIDENCE_DIR/desktop.cmdline" || exit 1

   printf 'mobile launcher PID=%s\nmobile native PID=%s\ndesktop PID=%s\n' \
     "$MOBILE_LAUNCHER_PID" "$MOBILE_NATIVE_PID" "$DESKTOP_PID"
   show_ppid_chain "$MOBILE_NATIVE_PID" || exit 1
   assert_descendant_of "$MOBILE_NATIVE_PID" "$MOBILE_LAUNCHER_PID" || exit 1
   assert_not_descendant_of "$DESKTOP_PID" "$MOBILE_LAUNCHER_PID" || exit 1
   print_argv "$DESKTOP_PID" || exit 1
   rollout_writer_fds "$MOBILE_NATIVE_PID" || exit 1
   rollout_writer_fds "$DESKTOP_PID" || exit 1
   ```

4. Authenticate without placing the password in argv or the document, then query the runtime endpoint with an encoded thread ID. The synthetic Host header prevents the trusted-localhost shortcut, so this checks the authenticated path.

   ```bash
   AUTH_JSON="$EVIDENCE_DIR/auth.json"
   IFS= read -rsp 'Codex Mobile password: ' CODEX_MOBILE_PASSWORD || exit 1
   printf '\n'
   if ! printf '%s' "$CODEX_MOBILE_PASSWORD" | node -e '
     let password = ""
     process.stdin.setEncoding("utf8")
     process.stdin.on("data", (chunk) => { password += chunk })
     process.stdin.on("end", () => process.stdout.write(JSON.stringify({ password })))
   ' > "$AUTH_JSON"; then
     unset CODEX_MOBILE_PASSWORD
     exit 1
   fi
   unset CODEX_MOBILE_PASSWORD
   curl -fsS -o /dev/null -c "$COOKIE_JAR" \
     -H 'Host: codex-mobile.test' -H 'Content-Type: application/json' \
     --data-binary @"$AUTH_JSON" "$SERVICE_URL/auth/login" || exit 1
   rm -f -- "$AUTH_JSON" || exit 1

   curl -fsS -b "$COOKIE_JAR" -H 'Host: codex-mobile.test' --get \
     --data-urlencode "threadId=$THREAD_ID" \
     "$SERVICE_URL/codex-api/thread-runtime-state" > "$EVIDENCE_DIR/running.json" || exit 1
   jq -e '
     .state == "running"
     and .interruptible == false
     and .source == "external-session-writer"
     and (.turnId | type == "string" and length > 0)
     and (keys | sort == ["interruptible", "source", "state", "turnId"])
   ' "$EVIDENCE_DIR/running.json" || exit 1
   ```

   Expect an exact payload shape of `{"state":"running","turnId":"<turn-id>","interruptible":false,"source":"external-session-writer"}` and the mobile composer to show the disabled “Running in another client” stop control.
5. Stop only the previously recorded desktop writer. Immediately before signalling, require the same starttime, byte-identical raw cmdline, qualifying command tokens, non-mobile ancestry, and matching rollout FD. If any check fails, abort without signalling. Never use `pkill`, `killall`, a PID rediscovered by name, or `systemctl stop/restart` for this step.

   ```bash
   [[ $DESKTOP_PID =~ ^[0-9]+$ ]] && ((DESKTOP_PID > 1)) || exit 1
   [[ $(proc_starttime "$DESKTOP_PID") == "$DESKTOP_STARTTIME" ]] || exit 1
   cmp -s "$PROC_ROOT/$DESKTOP_PID/cmdline" "$EVIDENCE_DIR/desktop.cmdline" || exit 1
   is_codex_app_server "$DESKTOP_PID" || exit 1
   has_argv_token "$DESKTOP_PID" 'features.code_mode_host=true' || exit 1
   assert_not_descendant_of "$DESKTOP_PID" "$MOBILE_LAUNCHER_PID" || exit 1
   rollout_writer_fds "$DESKTOP_PID" || exit 1
   kill -TERM -- "$DESKTOP_PID" || exit 1

   for ((attempt = 0; attempt < 50; attempt += 1)); do
     current_starttime="$(proc_starttime "$DESKTOP_PID" 2>/dev/null || true)"
     [[ $current_starttime != "$DESKTOP_STARTTIME" ]] && break
     sleep 0.1
   done
   [[ $(proc_starttime "$DESKTOP_PID" 2>/dev/null || true) != "$DESKTOP_STARTTIME" ]] || {
     printf 'desktop PID did not exit; do not escalate to SIGKILL\n' >&2
     exit 1
   }
   ```

6. Prove the mobile processes were neither stopped nor accepted as external evidence: require the original mobile launcher and native child identities and cmdlines to remain unchanged, require the native child still to descend from the launcher and still hold the rollout, require that no separate qualifying desktop writer remains, then query the endpoint again.

   ```bash
   [[ $(proc_starttime "$MOBILE_LAUNCHER_PID") == "$MOBILE_LAUNCHER_STARTTIME" ]] || exit 1
   [[ $(proc_starttime "$MOBILE_NATIVE_PID") == "$MOBILE_NATIVE_STARTTIME" ]] || exit 1
   cmp -s "$PROC_ROOT/$MOBILE_LAUNCHER_PID/cmdline" "$EVIDENCE_DIR/mobile-launcher.cmdline" || exit 1
   cmp -s "$PROC_ROOT/$MOBILE_NATIVE_PID/cmdline" "$EVIDENCE_DIR/mobile-native.cmdline" || exit 1
   assert_descendant_of "$MOBILE_NATIVE_PID" "$MOBILE_LAUNCHER_PID" || exit 1
   rollout_writer_fds "$MOBILE_NATIVE_PID" || exit 1

   for proc_dir in "$PROC_ROOT/"[0-9]*; do
     pid="${proc_dir##*/}"
     if is_codex_app_server "$pid" \
       && rollout_writer_fds "$pid" >/dev/null; then
       if classify_ancestry "$pid" "$MOBILE_LAUNCHER_PID"; then
         :
       else
         ancestry_result=$?
         if [[ $ancestry_result == 1 ]]; then
           printf 'unexpected non-mobile rollout writer pid=%s\n' "$pid" >&2
         else
           printf 'cannot validate ancestry for remaining writer pid=%s\n' "$pid" >&2
         fi
         exit 1
       fi
     fi
   done

   curl -fsS -b "$COOKIE_JAR" -H 'Host: codex-mobile.test' --get \
     --data-urlencode "threadId=$THREAD_ID" \
     "$SERVICE_URL/codex-api/thread-runtime-state" > "$EVIDENCE_DIR/idle.json" || exit 1
   jq -e '. == {"state":"idle"}' "$EVIDENCE_DIR/idle.json" || exit 1
   ```

   Expect exactly `{"state":"idle"}`. After the terminal detail refresh, the normal send control must return. The before/after pair proves that the separate desktop writer supplied the earlier `running` evidence while the still-live mobile descendant writer was excluded.

##### Cleanup
- If the procedure aborts before step 5, stop the test turn with Client A's normal stop control. If the recorded desktop PID still exists, repeat every identity check from step 5 before sending it `TERM`; never signal an unverified or reused PID and never escalate to `SIGKILL`.
- Close the disposable desktop and mobile test clients, remove any test-only queued message, and archive or delete the test thread through the normal UI if appropriate. Do not stop or restart `codex-mobile-safe.service` as cleanup.
- Exit the dedicated shell so its trap deletes the cookie jar, saved cmdlines, and JSON evidence, removes the now-empty evidence directory, and unsets the password variable.

##### Expected Results
- Command recognition treats `/proc/<pid>/cmdline` as NUL-delimited argv: an argv token whose basename is exactly `codex` must precede a later token that is exactly `app-server`. Options between those tokens are accepted; lookalike basenames, reversed ordering, and lookalike subcommands are rejected.
- The mobile launcher PID and every native or Node descendant whose validated parent chain reaches that PID are excluded. Only a separate qualifying desktop app-server can supply external writer evidence.
- Linux process identity is bound to `/proc/<pid>/stat` starttime while the process table and descriptor evidence are collected. PID reuse or a starttime change before or during descriptor enumeration makes the scan conservatively `unknown` instead of accepting stale writer evidence.
- Existing lifecycle, same-UID, exact rollout dev/ino, writable-descriptor, positive-position, canonical-path, and regular-file requirements remain in force.

##### Automated Acceptance
1. Run `pnpm vitest run src/server/externalThreadRuntime.test.ts src/server/externalThreadRuntimeBridge.test.ts`; both focused suites must pass.
2. Run `pnpm test:unit`; the complete unit suite must pass.
3. Run `pnpm build`; Vue type checking, Vite, and tsup must complete successfully.
4. Run `node dist-cli/safe.js doctor`; it must print `codex-mobile-safe doctor: ok`.
5. Run `git diff --check main..HEAD`; it must print nothing.

#### Rollback/Cleanup
- From Client A, stop the long-running turn if it is still active; after both clients show the terminal state, delete the prepared test-only queued row if it remains, restore Client B's original viewport and appearance, close Client B, and stop its Codex Mobile/app-server instance.
