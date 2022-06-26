import { mcs_proto } from './protos/mcs'

// list of mcs.proto types indexed by MCS tag
// (or strings, if mcs.proto doesn't have that type)

// WARNING: the order of these tags must remain the same, as the tag values
// must be consistent with those used on the server.
const types: any[] = [
  mcs_proto.HeartbeatPing,
  mcs_proto.HeartbeatAck,
  mcs_proto.LoginRequest,
  mcs_proto.LoginResponse,
  mcs_proto.Close,
  mcs_proto.DataMessageStanza,
  'PresenceStanza',
  mcs_proto.IqStanza,
  mcs_proto.DataMessageStanza,
  'BatchPresenceStanza',
  mcs_proto.StreamErrorStanza,
  'HttpRequest',
  'HttpResponse',
  'BindAccountRequest',
  'BindAccountResponse',
  'TalkMetadata',
]

export function tagToType(tag: number): any {
  return types[tag]
}

const _typeToTag: Record<any, number> = {}
for (let i = 0; i < types.length; ++i) {
  let name = types[i]
  if (typeof name !== 'string') name = name.name
  _typeToTag[name] = i
}
export function typeToTag(type: any): number | undefined {
  const name = (typeof type === 'string') ? type : type?.name
  return _typeToTag[name]
}
