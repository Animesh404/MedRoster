import { describe, expect, it } from 'vitest'
import { parseStaffRows, STAFF_RULES } from '@/lib/import/staff'
import { collectLegend, createFieldRule } from '@/lib/import/registry'

const HEADER = 'staff_id,full_name,role,email\n'
const one = (line: string) => parseStaffRows(HEADER + line + '\n')[0]!
const codes = (line: string) => one(line).issues.map((i) => i.code).sort()

describe('parseStaffRows — accepted', () => {
  it('accepts a clean row with no issues', () => {
    const r = one('121,Marcus Whitfield,Doctor,marcus.whitfield@clinicmail.test')
    expect(r.issues).toEqual([])
    expect(r.record).toEqual({
      externalId: 121, name: 'Marcus Whitfield',
      email: 'marcus.whitfield@clinicmail.test', profession: 'DOCTOR',
    })
  })
})

describe('parseStaffRows — repairs', () => {
  it('normalises every role alias to the enum', () => {
    expect(one('113,Tara Rahman,Registered Nurse,t@c.test').record!.profession).toBe('NURSE')
    expect(one('118,Omar Patel,MD,o@c.test').record!.profession).toBe('DOCTOR')
    expect(one('102,Hiro Petrova,recep.,h@c.test').record!.profession).toBe('RECEPTIONIST')
  })

  it('repairs an (at) email into a real address', () => {
    const r = one('122,Priya Weber,Doctor,priya.weber(at)clinicmail.test')
    expect(r.record!.email).toBe('priya.weber@clinicmail.test')
    expect(codes('122,Priya Weber,Doctor,priya.weber(at)clinicmail.test')).toContain('EMAIL_AT_LITERAL')
  })

  it('trims whitespace without re-casing the name', () => {
    const r = one('133,  Karan ALI,Reception,karan.ali@clinicmail.test')
    expect(r.record!.name).toBe('Karan ALI')   // ALI is preserved — §5.4
  })

  it('trims a padded role value', () => {
    expect(one('101,Ben Ali, Nurse ,ben.ali@clinicmail.test').record!.profession).toBe('NURSE')
  })

  it('lower-cases the email so collisions are detectable', () => {
    expect(one('140,Sam Roe,Nurse,Sam.Roe@Clinicmail.TEST').record!.email).toBe('sam.roe@clinicmail.test')
  })
})

describe('parseStaffRows — rejections', () => {
  it('rejects an unknown profession', () => {
    const r = one('997,Casey Morgan,Janitor,casey.morgan@clinicmail.test')
    expect(r.record).toBeNull()
    expect(codes('997,Casey Morgan,Janitor,casey.morgan@clinicmail.test')).toContain('UNKNOWN_PROFESSION')
  })

  it('rejects a blank name', () => {
    expect(one('996,,Doctor,noname@clinicmail.test').record).toBeNull()
    expect(codes('996,,Doctor,noname@clinicmail.test')).toContain('BLANK_NAME')
  })

  it('rejects a blank email because email is the login identity', () => {
    expect(one('995,Robin Vale,Nurse,').record).toBeNull()
    expect(codes('995,Robin Vale,Nurse,')).toContain('BLANK_EMAIL')
  })

  it('rejects an email that is still malformed after repair', () => {
    expect(one('140,Sam Roe,Nurse,not-an-email').record).toBeNull()
    expect(codes('140,Sam Roe,Nurse,not-an-email')).toContain('INVALID_EMAIL')
  })

  it('rejects a non-numeric staff id', () => {
    expect(one('abc,Sam Roe,Nurse,sam@c.test').record).toBeNull()
    expect(codes('abc,Sam Roe,Nurse,sam@c.test')).toContain('INVALID_ID')
  })

  it('rejects a row with the wrong number of columns', () => {
    expect(one('140,Sam Roe,Nurse').record).toBeNull()
    expect(codes('140,Sam Roe,Nurse')).toContain('BAD_ARITY')
  })
})

describe('parseStaffRows — reporting', () => {
  it('keeps the raw line and file line number for the report', () => {
    const r = one('997,Casey Morgan,Janitor,casey.morgan@clinicmail.test')
    expect(r.rowNumber).toBe(2)
    expect(r.raw).toBe('997,Casey Morgan,Janitor,casey.morgan@clinicmail.test')
  })
})

describe('STAFF_RULES — registry legend (Amendment A)', () => {
  it('collectLegend(STAFF_RULES) covers every code the staff rules can emit', () => {
    const codes = collectLegend(STAFF_RULES).map((d) => d.code).sort()
    expect(codes).toEqual([
      'BLANK_EMAIL',
      'BLANK_NAME',
      'EMAIL_AT_LITERAL',
      'EMAIL_CASE',
      'INVALID_EMAIL',
      'INVALID_ID',
      'NAME_WHITESPACE',
      'ROLE_ALIAS',
      'UNKNOWN_PROFESSION',
    ])
  })

  it('throws when a duplicate descriptor disagrees about what a code means', () => {
    const conflicting = createFieldRule({
      emits: [{
        code: 'BLANK_NAME',
        field: 'full_name',
        severity: 'FATAL' as const,
        describe: 'A deliberately conflicting description that does not match the real one.',
      }],
      run: (input: string) => input,
    })
    expect(() => collectLegend([...STAFF_RULES, conflicting])).toThrow()
  })
})
