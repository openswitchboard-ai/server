import { describe, expect, it } from 'vitest';
import { registrationModeFrom } from '../../src/config.js';

describe('registrationModeFrom', () => {
  it('prod is closed unless told otherwise', () => {
    expect(registrationModeFrom(undefined, 'prod')).toBe('closed');
    expect(registrationModeFrom('', 'prod')).toBe('closed');
    expect(registrationModeFrom('nonsense', 'prod')).toBe('closed');
  });
  it('one env value opens prod', () => {
    expect(registrationModeFrom('open', 'prod')).toBe('open');
  });
  it('other environments bootstrap by default and can be closed', () => {
    expect(registrationModeFrom(undefined, 'dev')).toBe('dev-bootstrap');
    expect(registrationModeFrom('closed', 'dev')).toBe('closed');
  });
});
