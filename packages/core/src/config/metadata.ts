export interface FieldAliases {
  [key: string]: Array<string>;
}
export const DEFAULT_FIELD_ALIASES: FieldAliases = {
  ssn: ["social_security_number", "social"],
  first_name: ["firstname", "fname"],
  last_name: ["lastname", "lname"],
  date_of_birth: ["dateofbirth", "dob"],
};
