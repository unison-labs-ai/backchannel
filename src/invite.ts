export interface Invite {
  url: string;
  token?: string;
  room?: string;
  channels?: string[];
}

const PREFIX = "bch1-";

export function encodeInvite(invite: Invite): string {
  return PREFIX + Buffer.from(JSON.stringify(invite)).toString("base64url");
}

export function decodeInvite(value: string): Invite {
  if (!value.startsWith(PREFIX)) {
    throw new Error("not a backchannel invite (expected it to start with bch1-)");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value.slice(PREFIX.length), "base64url").toString());
  } catch {
    throw new Error("malformed invite");
  }
  const invite = parsed as Invite;
  if (!invite.url) throw new Error("malformed invite: missing relay url");
  return invite;
}

const INSTALL_REPO = "github:unison-labs-ai/backchannel";

// What you send a teammate: a one-time install line + the single join command.
// `join` itself installs the etiquette into their harness, so nothing else is needed.
export function shareInstructions(inviteStr: string, headline: string): string {
  return `${headline}.

Send your teammate this line — they run it to join (replace the name):

  bch join ${inviteStr} --as their-name

First time? they install bch once:

  curl -fsSL https://bun.sh/install | bash && bun install -g ${INSTALL_REPO}

The code carries the relay URL + room secret, so share it privately.`;
}
