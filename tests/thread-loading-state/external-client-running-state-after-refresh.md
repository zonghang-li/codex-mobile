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

- Define helpers that preserve argv token boundaries, validate PID identity with `/proc/<pid>/stat` field 22, walk PPID links, and accept only a writable positive-position FD whose dev/ino and full flags stay stable across two fdinfo snapshots:

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

  stable_proc_record() {
    local pid="$1" starttime_before parent starttime_after
    starttime_before="$(proc_starttime "$pid")" || return 1
    parent="$(proc_ppid "$pid")" || return 1
    starttime_after="$(proc_starttime "$pid")" || return 1
    [[ $starttime_before == "$starttime_after" && $parent =~ ^[0-9]+$ ]] || return 1
    printf '%s %s\n' "$starttime_before" "$parent"
  }

  stable_proc_uid() {
    local pid="$1" starttime_before uid starttime_after
    starttime_before="$(proc_starttime "$pid")" || return 1
    uid="$(awk '$1 == "Uid:" { print $2; found=1; exit } END { if (!found) exit 1 }' \
      "$PROC_ROOT/$pid/status" 2>/dev/null)" || return 1
    starttime_after="$(proc_starttime "$pid")" || return 1
    [[ $starttime_before == "$starttime_after" && $uid =~ ^[0-9]+$ ]] || return 1
    printf '%s\n' "$uid"
  }

  stable_cmdline_snapshot() {
    local pid="$1" destination="$2" record_before record_after
    record_before="$(stable_proc_record "$pid")" || return 1
    cp "$PROC_ROOT/$pid/cmdline" "$destination" || return 1
    record_after="$(stable_proc_record "$pid")" || return 1
    [[ $record_before == "$record_after" ]] || return 1
    printf '%s\n' "$record_before"
  }

  revalidate_saved_process() {
    local pid="$1" expected_starttime="$2" saved_cmdline="$3"
    local current_cmdline record actual_starttime actual_parent result=0
    current_cmdline="$(mktemp "$EVIDENCE_DIR/revalidate-${pid}.XXXXXX.cmdline")" || return 1
    record="$(stable_cmdline_snapshot "$pid" "$current_cmdline")" || result=1
    if ((result == 0)); then
      read -r actual_starttime actual_parent <<< "$record"
      [[ $actual_starttime == "$expected_starttime" && $actual_parent =~ ^[0-9]+$ ]] || result=1
      cmp -s "$saved_cmdline" "$current_cmdline" || result=1
    fi
    rm -f -- "$current_cmdline"
    return "$result"
  }

  print_argv() {
    local pid="$1" index=0 arg
    while IFS= read -r -d '' arg; do
      printf 'pid=%s argv[%s]=%q\n' "$pid" "$index" "$arg"
      ((index += 1))
    done < "$PROC_ROOT/$pid/cmdline"
  }

  is_codex_app_server_file() {
    local cmdline="$1" saw_codex=0 arg
    while IFS= read -r -d '' arg; do
      if ((saw_codex)) && [[ $arg == app-server ]]; then return 0; fi
      [[ ${arg##*/} == codex ]] && saw_codex=1
    done < "$cmdline" 2>/dev/null
    return 1
  }

  has_argv_token_file() {
    local cmdline="$1" expected="$2" arg
    while IFS= read -r -d '' arg; do
      [[ $arg == "$expected" ]] && return 0
    done < "$cmdline" 2>/dev/null
    return 1
  }

  classify_ancestry() {
    local current="$1" root="$2" root_starttime="$3" depth record starttime parent
    local -A seen=()
    [[ $current =~ ^[0-9]+$ && $root =~ ^[0-9]+$ && $root_starttime =~ ^[0-9]+$ ]] || return 2
    for ((depth = 0; depth < 128; depth += 1)); do
      [[ -z ${seen[$current]+present} ]] || return 2
      seen[$current]=1
      record="$(stable_proc_record "$current")" || return 2
      read -r starttime parent <<< "$record"
      if [[ $current == "$root" ]]; then
        [[ $starttime == "$root_starttime" ]] || return 2
        return 0
      fi
      ((current == 1)) && return 1
      ((parent == 0)) && return 1
      current="$parent"
    done
    return 2
  }

  assert_descendant_of() {
    local result
    if classify_ancestry "$1" "$2" "$3"; then return 0; else result=$?; fi
    return "$result"
  }

  assert_not_descendant_of() {
    local result
    if classify_ancestry "$1" "$2" "$3"; then
      return 1
    else
      result=$?
    fi
    if [[ $result == 1 ]]; then return 0; fi
    return 2
  }

  show_ppid_chain() {
    local current="$1" root="$2" root_starttime="$3" depth record parent starttime
    local -A seen=()
    for ((depth = 0; depth < 128; depth += 1)); do
      [[ $current =~ ^[0-9]+$ ]] || return 1
      [[ -z ${seen[$current]+present} ]] || return 1
      seen[$current]=1
      record="$(stable_proc_record "$current")" || return 1
      read -r starttime parent <<< "$record"
      if [[ $current == "$root" && $starttime != "$root_starttime" ]]; then return 1; fi
      printf 'pid=%s ppid=%s starttime=%s\n' "$current" "$parent" "$starttime"
      print_argv "$current" || return 1
      [[ $current == 1 || $parent == 0 ]] && return 0
      [[ $parent =~ ^[0-9]+$ ]] || return 1
      current="$parent"
    done
    return 1
  }

  rollout_writer_fds() {
    local pid="$1" fd info fdinfo_before fdinfo_after
    local identity_before identity_middle identity_after
    local position_before position_after flags_before flags_after
    local access_before access_after target found=1 nullglob_was_set=0
    local -a fd_paths=()
    shopt -q nullglob && nullglob_was_set=1
    shopt -s nullglob
    fd_paths=("$PROC_ROOT/$pid/fd/"[0-9]*)
    ((nullglob_was_set)) || shopt -u nullglob
    for fd in "${fd_paths[@]}"; do
      [[ -e $fd ]] || return 2
      identity_before="$(stat -Lc '%d:%i' "$fd" 2>/dev/null)" || return 2
      info="$PROC_ROOT/$pid/fdinfo/${fd##*/}"
      fdinfo_before="$(< "$info")" || return 2
      identity_middle="$(stat -Lc '%d:%i' "$fd" 2>/dev/null)" || return 2
      fdinfo_after="$(< "$info")" || return 2
      target="$(readlink "$fd")" || return 2
      identity_after="$(stat -Lc '%d:%i' "$fd" 2>/dev/null)" || return 2
      [[ $identity_before == "$identity_middle" && $identity_middle == "$identity_after" ]] || return 2
      [[ $identity_before == "$ROLLOUT_IDENTITY" ]] || continue
      position_before="$(awk '$1 == "pos:" { print $2; exit }' <<< "$fdinfo_before")"
      flags_before="$(awk '$1 == "flags:" { print $2; exit }' <<< "$fdinfo_before")"
      position_after="$(awk '$1 == "pos:" { print $2; exit }' <<< "$fdinfo_after")"
      flags_after="$(awk '$1 == "flags:" { print $2; exit }' <<< "$fdinfo_after")"
      [[ $position_before =~ ^[0-9]+$ && $position_after =~ ^[0-9]+$ ]] || return 2
      [[ $flags_before =~ ^[0-7]+$ && $flags_after =~ ^[0-7]+$ ]] || return 2
      access_before=$(( (8#$flags_before) & 3 ))
      access_after=$(( (8#$flags_after) & 3 ))
      [[ $flags_before == "$flags_after" && $access_before == "$access_after" ]] || return 2
      printf 'pid=%s fd=%s pos=%s flags=%s target=%s\n' \
        "$pid" "${fd##*/}" "$position_after" "$flags_after" "$target"
      if ((position_after > 0 && (access_after == 1 || access_after == 2))); then found=0; fi
    done
    return "$found"
  }

  classify_rollout_writer() {
    local pid="$1" uid_before uid_after before_cmdline after_cmdline
    local record_before record_after fd_result
    uid_before="$(stable_proc_uid "$pid")" || return 2
    [[ $uid_before == "$EUID" ]] || return 1
    before_cmdline="$(mktemp "$EVIDENCE_DIR/candidate-${pid}.before.XXXXXX.cmdline")" || return 2
    after_cmdline="$(mktemp "$EVIDENCE_DIR/candidate-${pid}.after.XXXXXX.cmdline")" || {
      rm -f -- "$before_cmdline"
      return 2
    }
    record_before="$(stable_cmdline_snapshot "$pid" "$before_cmdline")" || {
      rm -f -- "$before_cmdline" "$after_cmdline"
      return 2
    }
    if ! is_codex_app_server_file "$before_cmdline"; then
      rm -f -- "$before_cmdline" "$after_cmdline"
      return 1
    fi
    if rollout_writer_fds "$pid"; then fd_result=0; else fd_result=$?; fi
    if [[ $fd_result == 2 ]]; then
      rm -f -- "$before_cmdline" "$after_cmdline"
      return 2
    fi
    record_after="$(stable_cmdline_snapshot "$pid" "$after_cmdline")" || {
      rm -f -- "$before_cmdline" "$after_cmdline"
      return 2
    }
    if [[ $record_before != "$record_after" ]] || ! cmp -s "$before_cmdline" "$after_cmdline"; then
      rm -f -- "$before_cmdline" "$after_cmdline"
      return 2
    fi
    uid_after="$(stable_proc_uid "$pid")" || {
      rm -f -- "$before_cmdline" "$after_cmdline"
      return 2
    }
    if [[ $uid_after != "$uid_before" || $uid_after != "$EUID" ]]; then
      rm -f -- "$before_cmdline" "$after_cmdline"
      return 2
    fi
    rm -f -- "$before_cmdline" "$after_cmdline"
    return "$fd_result"
  }
  ```

##### Steps
1. Start or select a disposable desktop Client A whose app-server is launched in the production argv layout `codex -c features.code_mode_host=true app-server --listen unix://`. A bare app-server without its desktop JSON-RPC client cannot drive this check. In Client A, open `THREAD_ID`, submit a test-only prompt such as “run `sleep 300`, then report completion,” and confirm the turn is still running. Open the same thread in `codex-mobile-safe` so its own app-server resumes the rollout.
2. Record the mobile service launcher PID directly from systemd. Do not classify ancestry yet: the next step first binds this PID to a stable starttime.

   ```bash
   [[ $(systemctl --user show codex-mobile-safe.service -p ActiveState --value) == active ]] || exit 1
   MOBILE_LAUNCHER_PID="$(systemctl --user show codex-mobile-safe.service -p MainPID --value)"
   [[ $MOBILE_LAUNCHER_PID =~ ^[0-9]+$ ]] && ((MOBILE_LAUNCHER_PID > 1)) || exit 1
   ```

3. First capture the launcher's stable `(starttime, PPid, UID)` evidence and raw argv, and verify systemd still names the same `MainPID`. Only then enumerate stable same-UID app-server command snapshots that hold the exact rollout through stable descriptor and dual-fdinfo snapshots. Every ancestry classification must use the recorded launcher starttime. Finally capture the selected native and desktop identities, UIDs, and raw argv before changing any process.

   ```bash
   launcher_record="$(stable_cmdline_snapshot \
     "$MOBILE_LAUNCHER_PID" "$EVIDENCE_DIR/mobile-launcher.cmdline")" || exit 1
   read -r MOBILE_LAUNCHER_STARTTIME MOBILE_LAUNCHER_PPID <<< "$launcher_record"
   MOBILE_LAUNCHER_UID="$(stable_proc_uid "$MOBILE_LAUNCHER_PID")" || exit 1
   [[ $MOBILE_LAUNCHER_STARTTIME =~ ^[0-9]+$ && $MOBILE_LAUNCHER_PPID =~ ^[0-9]+$ ]] || exit 1
   [[ $MOBILE_LAUNCHER_UID == "$EUID" ]] || exit 1
   [[ $(systemctl --user show codex-mobile-safe.service -p MainPID --value) == "$MOBILE_LAUNCHER_PID" ]] || exit 1

   WRITER_PIDS=()
   for proc_dir in "$PROC_ROOT/"[0-9]*; do
     pid="${proc_dir##*/}"
     if classify_rollout_writer "$pid" >/dev/null; then
       WRITER_PIDS+=("$pid")
     else
       writer_result=$?
       if [[ $writer_result == 2 ]]; then
         printf 'inconclusive writer snapshot for pid=%s\n' "$pid" >&2
         exit 1
       fi
     fi
   done

   MOBILE_WRITER_PIDS=()
   DESKTOP_CANDIDATES=()
   for pid in "${WRITER_PIDS[@]}"; do
     candidate_cmdline="$EVIDENCE_DIR/candidate-${pid}.cmdline"
     stable_cmdline_snapshot "$pid" "$candidate_cmdline" >/dev/null || exit 1
     if classify_ancestry "$pid" "$MOBILE_LAUNCHER_PID" "$MOBILE_LAUNCHER_STARTTIME"; then
       MOBILE_WRITER_PIDS+=("$pid")
     else
       ancestry_result=$?
       if [[ $ancestry_result == 1 ]]; then
         if has_argv_token_file "$candidate_cmdline" 'features.code_mode_host=true' \
           && has_argv_token_file "$candidate_cmdline" app-server \
           && has_argv_token_file "$candidate_cmdline" --listen \
           && has_argv_token_file "$candidate_cmdline" 'unix://'; then
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
     candidate_cmdline="$EVIDENCE_DIR/candidate-${pid}.cmdline"
     stable_cmdline_snapshot "$pid" "$candidate_cmdline" >/dev/null || exit 1
     IFS= read -r -d '' argv0 < "$candidate_cmdline" || exit 1
     [[ ${argv0##*/} == codex ]] && MOBILE_NATIVE_CANDIDATES+=("$pid")
   done
   ((${#MOBILE_NATIVE_CANDIDATES[@]} == 1)) || { printf 'ambiguous mobile native writers\n' >&2; exit 1; }
   ((${#DESKTOP_CANDIDATES[@]} == 1)) || { printf 'ambiguous desktop writers\n' >&2; exit 1; }
   MOBILE_NATIVE_PID="${MOBILE_NATIVE_CANDIDATES[0]}"
   DESKTOP_PID="${DESKTOP_CANDIDATES[0]}"

   native_record="$(stable_cmdline_snapshot \
     "$MOBILE_NATIVE_PID" "$EVIDENCE_DIR/mobile-native.cmdline")" || exit 1
   desktop_record="$(stable_cmdline_snapshot \
     "$DESKTOP_PID" "$EVIDENCE_DIR/desktop.cmdline")" || exit 1
   read -r MOBILE_NATIVE_STARTTIME MOBILE_NATIVE_PPID <<< "$native_record"
   read -r DESKTOP_STARTTIME DESKTOP_PPID <<< "$desktop_record"
   MOBILE_NATIVE_UID="$(stable_proc_uid "$MOBILE_NATIVE_PID")" || exit 1
   DESKTOP_UID="$(stable_proc_uid "$DESKTOP_PID")" || exit 1
   [[ $MOBILE_NATIVE_STARTTIME =~ ^[0-9]+$ && $MOBILE_NATIVE_PPID =~ ^[0-9]+$ ]] || exit 1
   [[ $DESKTOP_STARTTIME =~ ^[0-9]+$ && $DESKTOP_PPID =~ ^[0-9]+$ ]] || exit 1
   [[ $MOBILE_NATIVE_UID == "$EUID" && $DESKTOP_UID == "$EUID" ]] || exit 1

   printf 'mobile launcher PID=%s\nmobile native PID=%s\ndesktop PID=%s\n' \
     "$MOBILE_LAUNCHER_PID" "$MOBILE_NATIVE_PID" "$DESKTOP_PID"
   show_ppid_chain "$MOBILE_NATIVE_PID" "$MOBILE_LAUNCHER_PID" "$MOBILE_LAUNCHER_STARTTIME" || exit 1
   assert_descendant_of \
     "$MOBILE_NATIVE_PID" "$MOBILE_LAUNCHER_PID" "$MOBILE_LAUNCHER_STARTTIME" || exit 1
   assert_not_descendant_of \
     "$DESKTOP_PID" "$MOBILE_LAUNCHER_PID" "$MOBILE_LAUNCHER_STARTTIME" || exit 1
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
5. Stop only the previously recorded desktop writer. Immediately before signalling, require the recorded same UIDs, desktop identity and command, and revalidate that systemd still names the recorded mobile root and that its stable identity and command are unchanged. Then require qualifying desktop command tokens, non-mobile ancestry bound to that root starttime, and a stable matching rollout FD. After the FD helper returns, repeat the full ancestry, UID, systemd-root, and both process-identity validations immediately before the single `TERM`. If any check is changed or inconclusive, abort without signalling. Never use `pkill`, `killall`, a PID rediscovered by name, or `systemctl stop/restart` for this step.

   ```bash
   [[ $DESKTOP_PID =~ ^[0-9]+$ ]] && ((DESKTOP_PID > 1)) || exit 1
   [[ $(systemctl --user show codex-mobile-safe.service -p MainPID --value) == "$MOBILE_LAUNCHER_PID" ]] || exit 1
   revalidate_saved_process "$MOBILE_LAUNCHER_PID" "$MOBILE_LAUNCHER_STARTTIME" \
     "$EVIDENCE_DIR/mobile-launcher.cmdline" || exit 1
   revalidate_saved_process "$DESKTOP_PID" "$DESKTOP_STARTTIME" \
     "$EVIDENCE_DIR/desktop.cmdline" || exit 1
   [[ $(stable_proc_uid "$MOBILE_LAUNCHER_PID") == "$MOBILE_LAUNCHER_UID" ]] || exit 1
   [[ $(stable_proc_uid "$DESKTOP_PID") == "$DESKTOP_UID" ]] || exit 1
   is_codex_app_server_file "$EVIDENCE_DIR/desktop.cmdline" || exit 1
   has_argv_token_file "$EVIDENCE_DIR/desktop.cmdline" 'features.code_mode_host=true' || exit 1
   assert_not_descendant_of \
     "$DESKTOP_PID" "$MOBILE_LAUNCHER_PID" "$MOBILE_LAUNCHER_STARTTIME" || exit 1
   rollout_writer_fds "$DESKTOP_PID" || exit 1
   assert_not_descendant_of \
     "$DESKTOP_PID" "$MOBILE_LAUNCHER_PID" "$MOBILE_LAUNCHER_STARTTIME" || exit 1
   [[ $(stable_proc_uid "$MOBILE_LAUNCHER_PID") == "$MOBILE_LAUNCHER_UID" ]] || exit 1
   [[ $(stable_proc_uid "$DESKTOP_PID") == "$DESKTOP_UID" ]] || exit 1
   [[ $(systemctl --user show codex-mobile-safe.service -p MainPID --value) == "$MOBILE_LAUNCHER_PID" ]] || exit 1
   revalidate_saved_process "$MOBILE_LAUNCHER_PID" "$MOBILE_LAUNCHER_STARTTIME" \
     "$EVIDENCE_DIR/mobile-launcher.cmdline" || exit 1
   revalidate_saved_process "$DESKTOP_PID" "$DESKTOP_STARTTIME" \
     "$EVIDENCE_DIR/desktop.cmdline" || exit 1
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
   [[ $(systemctl --user show codex-mobile-safe.service -p MainPID --value) == "$MOBILE_LAUNCHER_PID" ]] || exit 1
   revalidate_saved_process "$MOBILE_LAUNCHER_PID" "$MOBILE_LAUNCHER_STARTTIME" \
     "$EVIDENCE_DIR/mobile-launcher.cmdline" || exit 1
   revalidate_saved_process "$MOBILE_NATIVE_PID" "$MOBILE_NATIVE_STARTTIME" \
     "$EVIDENCE_DIR/mobile-native.cmdline" || exit 1
   [[ $(stable_proc_uid "$MOBILE_LAUNCHER_PID") == "$MOBILE_LAUNCHER_UID" ]] || exit 1
   [[ $(stable_proc_uid "$MOBILE_NATIVE_PID") == "$MOBILE_NATIVE_UID" ]] || exit 1
   assert_descendant_of \
     "$MOBILE_NATIVE_PID" "$MOBILE_LAUNCHER_PID" "$MOBILE_LAUNCHER_STARTTIME" || exit 1
   rollout_writer_fds "$MOBILE_NATIVE_PID" || exit 1
   assert_descendant_of \
     "$MOBILE_NATIVE_PID" "$MOBILE_LAUNCHER_PID" "$MOBILE_LAUNCHER_STARTTIME" || exit 1
   [[ $(stable_proc_uid "$MOBILE_LAUNCHER_PID") == "$MOBILE_LAUNCHER_UID" ]] || exit 1
   [[ $(stable_proc_uid "$MOBILE_NATIVE_PID") == "$MOBILE_NATIVE_UID" ]] || exit 1
   revalidate_saved_process "$MOBILE_LAUNCHER_PID" "$MOBILE_LAUNCHER_STARTTIME" \
     "$EVIDENCE_DIR/mobile-launcher.cmdline" || exit 1
   revalidate_saved_process "$MOBILE_NATIVE_PID" "$MOBILE_NATIVE_STARTTIME" \
     "$EVIDENCE_DIR/mobile-native.cmdline" || exit 1

   for proc_dir in "$PROC_ROOT/"[0-9]*; do
     pid="${proc_dir##*/}"
     if classify_rollout_writer "$pid" >/dev/null; then
       if classify_ancestry \
         "$pid" "$MOBILE_LAUNCHER_PID" "$MOBILE_LAUNCHER_STARTTIME"; then
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
     else
       writer_result=$?
       if [[ $writer_result == 2 ]]; then
         printf 'inconclusive remaining-writer snapshot pid=%s\n' "$pid" >&2
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
- Linux process identity is bound to `/proc/<pid>/stat` starttime while the process table and descriptor evidence are collected. Each manual ancestry hop brackets its `status`/`PPid` read with matching starttime reads and binds the mobile root to its recorded starttime. Each rollout FD uses three matching descriptor dev/ino reads around two parsed fdinfo snapshots; full flags and access mode must remain stable, while the second snapshot supplies the current position and flags. Candidate UID is revalidated after FD inspection. PID reuse, UID or ancestry mutation, FD-number reuse, flags/access change, disappearance, or an inconclusive identity read aborts the manual procedure instead of accepting mixed writer evidence.
- Existing lifecycle, same-UID, exact rollout dev/ino, writable-descriptor, positive-position, canonical-path, and regular-file requirements remain in force.

##### Automated Acceptance
1. Run `pnpm vitest run src/server/externalThreadRuntime.test.ts src/server/externalThreadRuntimeBridge.test.ts`; both focused suites must pass.
2. Run `pnpm test:unit`; the complete unit suite must pass.
3. Run `pnpm build`; Vue type checking, Vite, and tsup must complete successfully.
4. Run `node dist-cli/safe.js doctor`; it must print `codex-mobile-safe doctor: ok`.
5. Run `git diff --check main..HEAD`; it must print nothing.

#### Rollback/Cleanup
- From Client A, stop the long-running turn if it is still active; after both clients show the terminal state, delete the prepared test-only queued row if it remains, restore Client B's original viewport and appearance, close Client B, and stop its Codex Mobile/app-server instance.
