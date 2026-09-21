// hooks/useLoginForm.js — the sign-in form and the student account-recovery form.
// Moved out of App() on 2026-09-21 as one contiguous run, so the order of every hook and effect is unchanged.
import { useState } from "react";

export function useLoginForm() {
  // Login fields
  const [lEmail, setLEmail] = useState("");
  const [lPass, setLPass] = useState("");
  const [lError, setLError] = useState("");
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
