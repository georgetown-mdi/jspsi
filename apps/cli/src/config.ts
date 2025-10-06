import fs from 'node:fs'

import { z } from 'zod';

interface ArgumentMeta {
  describe?: string;
  alias?: string | readonly string[];
  optionPath?: string;
  coerce?: (val: string) => string;
}

interface OptionalArgumentMeta extends ArgumentMeta {
  type: 'string' | 'number' | 'boolean' | undefined;
}

interface PositionalArgumentMeta extends ArgumentMeta {
  position: number;
  demandOption: boolean;
}

interface CliRegistryMeta extends Pick<ArgumentMeta, 'describe' | 'alias' | 'coerce'>{
  position?: number;
  optionName?: string;
}

const cliRegistry = z.registry<CliRegistryMeta>();

const readAtFile = (val: string) => {
  if (typeof val === 'string' && val.startsWith('@'))
    return fs.readFileSync(val.slice(1), 'utf8').trim();
  return val;
}

const sftpConfigSchema = z.strictObject({
  port: z.optional(z.int().min(0).max(65535)).register(cliRegistry, { describe: 'port number of the server' }),
  forceIPv4: z.optional(z.stringbool()).register(cliRegistry, { optionName: 'force-ip-v4', describe: 'only connect via resolved IPv4 address for `host`' }),
  forceIPv6: z.optional(z.stringbool()).register(cliRegistry, { optionName: 'force-ip-v6', describe: 'only connect via resolved IPv6 address for `host`' }),
  username: z.optional(z.string()).register(cliRegistry, { describe: 'username for authentication' }),
  password: z.optional(z.string()).register(cliRegistry, { describe: 'password for password-based user authentication; use @path to read from file', coerce: readAtFile }),
  agent: z.optional(z.string()).register(cliRegistry, { describe: 'path to ssh-agent\'s UNIX socket for ssh-agent-based user authentication (or \'pageant\' when using Pagent on Windows)' }),
  privateKey: z.optional(z.string()).register(cliRegistry, { describe: 'buffer or string that contains a private key for either key-based or hostbased user authentication (OpenSSH format); use @path to read from file', coerce: readAtFile }),
  passphrase: z.optional(z.string()).register(cliRegistry, { describe: 'for an encrypted private key, this is the passphrase used to decrypt it; use @path to read from file', coerce: readAtFile }),
  localHostname: z.optional(z.string()).register(cliRegistry, { describe: 'along with `localUsername` and `privateKey`, set this to a non-empty string for host-based user authentication' }),
  localUsername: z.optional(z.string()).register(cliRegistry, { describe: 'along with `localHostname` and `privateKey`, set this to a non-empty string for host-based user authentication' }),
  keepaliveInterval: z.optional(z.number().nonnegative()).register(cliRegistry, { describe: 'how often (in milliseconds) to send SSH-level keepalive packets to the server. Set to 0 to disable' }),
  keepaliveCountMax: z.optional(z.number()).register(cliRegistry, { describe: 'how many consecutive, unanswered SSH-level keepalive packets that can be sent to the server before disconnection' }),
  readyTimeout: z.optional(z.int().nonnegative()).register(cliRegistry, { describe: 'how long (in milliseconds) to wait for the SSH handshake to complete' }),
  strictVendor: z.optional(z.stringbool()).register(cliRegistry, { describe: 'performs a strict server vendor check before sending vendor-specific requests' }),
  agentForward: z.optional(z.stringbool()).register(cliRegistry, { describe: 'set to `true` to use OpenSSH agent forwarding (`auth-agent@openssh.com`) for the life of the connection' }),
  localAddress: z.optional(z.union([z.ipv4(), z.ipv6(), z.literal('localhost')])).register(cliRegistry, { describe: 'IP address of the network interface to use to connect to the server; default: (none -- determined by OS)' }),
  localPort: z.optional(z.int().min(0).max(65535)).register(cliRegistry, { describe: 'the local port number to connect from; default: (none -- determined by OS)' }),
  timeout: z.optional(z.number().nonnegative()).register(cliRegistry, {  describe: 'the underlying socket timeout in ms; default: none)' }),
  ident: z.optional(z.string()).register(cliRegistry, { describe: 'acustom server software name/version identifier; default: \'ssh2js\' + moduleVersion + \'srv\'' }),
  promiseLimit: z.optional(z.int().nonnegative()).register(cliRegistry, { describe: 'max concurrent promises for downloadDir/uploadDir' }),
});

export const configSchema = z.strictObject({
  server: z.url({protocol: /^(https?)|(sftp)$/}).register(cliRegistry, {
    position: 0,
    describe: 'server URL',
  }),
  input: z.string().register(cliRegistry, {
    position: 1,
    describe: 'input file path; if `-` will read from stdin',
  }),
  output: z.optional(z.string()).register(cliRegistry, {
    position: 2,
    describe: 'output file path; if empty, writes to stdout',
  }),
  passkey: z.optional(z.string()).register(cliRegistry, {
    describe: 'passkey for authentication; use @path to read from file', coerce: readAtFile,
  }),
  timeout: z.optional(z.number().positive().default(60 * 15)).register(
    cliRegistry, {
      describe: 'Seconds to wait for peer before quitting'
    }
  ),
  serverOptions: z.optional(sftpConfigSchema).register(cliRegistry, { optionName: 'server', describe: 'Server Options:' })
});

export type Config = z.infer<typeof configSchema>;



export interface CliSpec {
  positionals: Array<{ key: string; meta: PositionalArgumentMeta }>;
  options: Array<{ key: string; meta: OptionalArgumentMeta }>;
  groups: Array<[Array<string>, string]>;
}

export function schemaToYargs(schema: z.ZodObject<any>): CliSpec {
  const shape = schema.shape;
  const positionals: CliSpec["positionals"] = [];
  const options: CliSpec["options"] = [];
  const groups: CliSpec['groups'] = [];

  for (const key of Object.keys(shape)) {
    const node = shape[key] as z.ZodObject<any>;
    const nodeInner = node instanceof z.ZodOptional ? (node as z.ZodOptional).def.innerType : node;
    const meta = cliRegistry.get(node);

    const optionName = meta?.optionName || key.replace(/[A-Z]/g, x => `-${x.toLowerCase()}`);

    if (nodeInner instanceof z.ZodObject) {
      const { options: innerOptions } = schemaToYargs(nodeInner);
      const groupId = key;
      const groupName = optionName;
      const groupMembers: Array<string> = []

      innerOptions.forEach(({key, meta}) => {
        // NOTE: for nested options, the preferred name was substituted when
        // the nested-party was evaluated recursively.

        // what it is called as a CLI option, e.g. server-force-ip-v4
        const optionName = groupName + '-' + key;
        const { optionPath, ...otherProperties } = meta;
        options.push({
          key: optionName,
          meta: {
            ...otherProperties,
            optionPath: optionPath || (groupId + '__' + key) // how to represent it internally so as to expand it later
          }
        });
        groupMembers.push(optionName);
      });

      if (meta?.describe) groups.push([groupMembers, meta?.describe]);
    }
    if (!meta) continue;

    if (meta.position !== undefined) {
      positionals.push({
        key: optionName,
        meta: {
          position: meta.position,
          demandOption: !node.safeParse(undefined).success,
          ...(({ optionName, position, ...otherArguments}) => otherArguments)(meta)
        },
      });
    } else {
      const otherProperties = (({ optionName, position, ...otherArguments}) => otherArguments)(meta);
      // map Zod type to Yargs type
      let type: OptionalArgumentMeta['type'];

      if (nodeInner instanceof z.ZodString) type = "string";
      if (nodeInner instanceof z.ZodNumber) type = "number";
      if (nodeInner instanceof z.ZodBoolean) type = "boolean";

      options.push({
        key: optionName,
        meta: {
          type,
          ...otherProperties
        }
      });
    }
  }

  // sort positionals by position
  positionals.sort((a, b) => a.meta.position - b.meta.position);

  return { positionals, options, groups };
}

export function flattenObject(
  obj: Record<string, any>,
  parentKey = "",
  sep = "__"
): Record<string, any> {
  const flattened: Record<string, any> = {};

  for (const [key, value] of Object.entries(obj)) {
    const newKey = parentKey ? `${parentKey}${sep}${key}` : key;

    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(flattened, flattenObject(value, newKey, sep));
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === "object" && item !== null) {
          Object.assign(flattened, flattenObject(item, `${newKey}${sep}${i}`, sep));
        } else {
          flattened[`${newKey}${sep}${i}`] = item;
        }
      })
    } else {
      flattened[newKey] = value;
    }
  }

  return flattened;
}

export function unflattenObject(
  obj: Record<string, any>,
  sep = "__"
): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [flatKey, value] of Object.entries(obj)) {
    const keys = flatKey.split(sep);
    let current: any = result;

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const isLast = i === keys.length - 1;
      const nextKey = keys[i + 1];
      const nextIsAnIndex = nextKey !== undefined && /^\d+$/.test(nextKey);

      if (isLast) {
        current[key] = value;
      } else {
        if (!(key in current)) {
          current[key] = nextIsAnIndex ? [] : {};
        }
        current = current[key];
      }
    }
  }

  return result;
}
