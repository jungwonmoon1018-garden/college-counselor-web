// hooks/useSyncBase.js — the profile's sync base (profile/profile-reconcile.js)
// and whether this session has joined its data with the server's yet.
//
// The base is state, so the auto-save re-runs and the vault is rewritten when
// it moves, and a ref, so handlers that awaited a fetch can tell whether a
// save landed while they waited: a profile read that started before a save
// is older than it and must not be merged over it.
import { useCallback, useRef, useState } from "react";

export function useSyncBase() {
  const [syncBase, setSyncBaseState] = useState(null);
  const syncBaseRef = useRef(null);
  const setSyncBase = useCallback((next) => {
    syncBaseRef.current = next;
    setSyncBaseState(next);
  }, []);
  const getSyncBase = useCallback(() => syncBaseRef.current, []);
  // False until a login, a signup or a later profile pull has joined the
  // device's data with the server's. The auto-save sends nothing before
  // then: a device that has not seen the server's profile cannot know which
  // of its fields are edits and which are only old.
  const [profileReady, setProfileReady] = useState(false);
  // True while a save is out. Saves from this device go one at a time: a
  // second save sent before the first answered carried the first's base
  // revision and came back as a conflict with "another device".
  const syncInFlightRef = useRef(false);
  return { getSyncBase, profileReady, setProfileReady, setSyncBase, syncBase, syncInFlightRef };
}
