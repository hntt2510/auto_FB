import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { profileNameSchema } from '@shared/schemas';

export class ProfilePathError extends Error {
  constructor(message: string) { super(message); this.name = 'ProfilePathError'; }
}

export class ProfileManager {
  constructor(public readonly profilesRoot: string) {
    if (existsSync(profilesRoot) && lstatSync(profilesRoot).isSymbolicLink()) throw new ProfilePathError('Profiles root cannot be a symbolic link');
    mkdirSync(profilesRoot, { recursive: true });
  }

  validateName(profileName: string): string {
    const parsed = profileNameSchema.safeParse(profileName);
    if (!parsed.success) throw new ProfilePathError(parsed.error.issues[0]?.message ?? 'Invalid profile name');
    return parsed.data;
  }

  getProfileDirectory(profileName: string): string {
    const safeName = this.validateName(profileName);
    const path = resolve(this.profilesRoot, safeName);
    if (dirname(path) !== resolve(this.profilesRoot) || basename(path) !== safeName) throw new ProfilePathError('Profile path must be inside the profiles root');
    return path;
  }

  assertNewProfile(profileName: string): string {
    const path = this.getProfileDirectory(profileName);
    if (existsSync(path)) throw new ProfilePathError('A profile with this name already exists');
    return path;
  }

  createProfile(profileName: string): string {
    const path = this.assertNewProfile(profileName);
    mkdirSync(path, { recursive: true });
    return path;
  }

  assertControlledDirectory(profileDirectory: string): void {
    const root = resolve(this.profilesRoot);
    const target = resolve(profileDirectory);
    if (dirname(target) !== root || basename(target) === '.' || basename(target) === '..') throw new ProfilePathError('Profile path is outside the controlled profiles root');
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new ProfilePathError('Symbolic-link profiles are not allowed');
  }

  deleteProfile(profileDirectory: string): void {
    this.assertControlledDirectory(profileDirectory);
    if (!existsSync(profileDirectory)) return;
    const entries = readdirSync(this.profilesRoot);
    if (!entries.includes(basename(profileDirectory))) throw new ProfilePathError('Profile path is not controlled by this application');
    rmSync(profileDirectory, { recursive: true, force: false });
  }
}
