export interface Invite {
  url: string;
  token?: string;
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
