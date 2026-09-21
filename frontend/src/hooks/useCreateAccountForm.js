// hooks/useCreateAccountForm.js — the create-account form's fields and flags.
// Moved out of App() on 2026-09-21 as one contiguous run, so the order of every hook and effect is unchanged.
import { useState } from "react";

export function useCreateAccountForm() {
  // Create account fields
  // Name is collected as first + last (browser autofill via autoComplete
  // given-name/family-name); cName stays as the combined value the rest of
  // the app and the backend already expect.
  const [cFirst, setCFirst] = useState("");
  const [cLast, setCLast] = useState("");
  const cName = `${cFirst} ${cLast}`.replace(/\s+/g, " ").trim();
  const [cEmail, setCEmail] = useState("");
  const [cGrade, setCGrade] = useState("");
  const [cPass, setCPass] = useState("");
  const [cPass2, setCPass2] = useState("");
  const [cAgeAttest, setCAgeAttest] = useState(false);
  const [cConsentAI, setCConsentAI] = useState(false);
  const [cConsentData, setCConsentData] = useState(false);
  const [cError, setCError] = useState("");
  const [showCreatePass, setShowCreatePass] = useState(false);
  const [showCreatePass2, setShowCreatePass2] = useState(false);
  return {
    cAgeAttest, cConsentAI, cConsentData, cEmail, cError, cFirst,
    cGrade, cLast, cName, cPass, cPass2, setCAgeAttest,
    setCConsentAI, setCConsentData, setCEmail, setCError, setCFirst, setCGrade,
    setCLast, setCPass, setCPass2, setShowCreatePass, setShowCreatePass2, showCreatePass,
    showCreatePass2,
  };
}
