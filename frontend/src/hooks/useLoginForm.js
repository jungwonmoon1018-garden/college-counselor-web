// hooks/useLoginForm.js — the sign-in form and the student account-recovery form.
// Moved out of App() on 2026-09-21 as one contiguous run, so the order of every hook and effect is unchanged.
//
// These fields live in the per-student tree App.jsx remounts when a session
// ends, so they start empty for whoever sits down next. They used to outlive
// the session: after a log out or the inactivity expiry the login screen
// still held the email and the whole passphrase (the vault key as well as
// the server credential), the Show toggle revealed it, and one click on
// "Sign in" opened the account again. `initialError` carries the reason the
// last session ended (the expiry notice) into the fresh form.
import { useState } from "react";

export function useLoginForm({ initialError = "" } = {}) {
  // Login fields
  const [lEmail, setLEmail] = useState("");
  const [lPass, setLPass] = useState("");
  const [lError, setLError] = useState(initialError);
  const [showLoginPass, setShowLoginPass] = useState(false);
  const [studentRecoveryOpen, setStudentRecoveryOpen] = useState(false);
  const [studentRecoveryInput, setStudentRecoveryInput] = useState("");
  const [studentRecoveryPassword, setStudentRecoveryPassword] = useState("");
  const [studentRecoveryBusy, setStudentRecoveryBusy] = useState(false);
  const [studentRecoveryMessage, setStudentRecoveryMessage] = useState(null);
  const [studentRecoveryCode, setStudentRecoveryCode] = useState("");
  return {
    lEmail, lError, lPass, setLEmail, setLError, setLPass,
    setShowLoginPass, setStudentRecoveryBusy, setStudentRecoveryCode, setStudentRecoveryInput, setStudentRecoveryMessage, setStudentRecoveryOpen,
    setStudentRecoveryPassword, showLoginPass, studentRecoveryBusy, studentRecoveryCode, studentRecoveryInput, studentRecoveryMessage,
    studentRecoveryOpen, studentRecoveryPassword,
  };
}
