// The client's envelope around a chat question: the "[Attached files — …]"
// block that carries uploaded text files, the "[Context appendix — …]"
// block of reference data (calendar, cached counseling memory), and the
// single-upload priming sentence. Classification and the input screen must
// run on the student's question alone, and a turn must be recognized as an
// attachment turn (its answer is grounded in the document, so the profile
// fidelity check stands down).
//
// The client's sanitizer strips every "[" and "]" from the message before
// it is sent, so the sentinels arrive as "Attached files — …" and "End of
// attached files" with no brackets. The server's patterns used to require
// the brackets; nothing was stripped, the whole document (and the
// calendar's "FAFSA opens …") was classified, and a question about an
// uploaded certificate came back decorated as a regulated-aid turn. The
// brackets are optional here.

const CONTEXT_APPENDIX_RE = /\[?context appendix[\s\S]*?(\[?end context appendix\]?|$)/gi;
const ATTACHED_FILES_RE = /\[?Attached files —[\s\S]*?(\[?End of attached files\]?|$)/gi;
const UPLOAD_PRIMING_RE = /The student uploaded "[^"]*"\.[\s\S]*?answer their question about it substantively\.\s*/i;
const ATTACHMENT_TURN_RE = /\[?Attached files —|The student uploaded "/i;

/**
 * The student's question, with the client's envelope removed. Falls back
 * to the whole text when nothing is left (a turn that is only a file).
 */
export function stripClientEnvelope(userText) {
  const text = String(userText || "");
  return text
    .replace(CONTEXT_APPENDIX_RE, "")
    .replace(ATTACHED_FILES_RE, "")
    .replace(UPLOAD_PRIMING_RE, "")
    .trim() || text;
}

/** Whether the text of a turn carries an attached-file preface or the single-upload priming sentence. */
export function hasAttachmentPreface(userText) {
  return ATTACHMENT_TURN_RE.test(String(userText || ""));
}
