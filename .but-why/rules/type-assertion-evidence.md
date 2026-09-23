# Unsupported type assertions

A TypeScript assertion changes the static type without checking the value at runtime. This rule protects code from relying on a claimed field or variant before validation or a concrete contract establishes that shape; an unchecked use can fail on malformed input or make an invalid decision.

In a change review, inspect non-`const` TypeScript assertions (`value as T` or `<T>value`) when a change adds or modifies an assertion, changes validation it relies on, adds a use of its asserted shape, or changes or removes a comment justifying it. In a file or repository audit, inspect assertions in scope even when unchanged. Ignore quoted code and deliberately failing fixtures unless they execute as part of the changed program.

Report a violation only when code uses a type, field, or variant claimed by the assertion before the source value has been checked for that claim or an identifiable static or host contract establishes it. Trace the source to the first use. A rationale comment or lint suppression is not evidence; a later check does not justify an earlier unchecked use. Do not report a cast solely because a different implementation could avoid it.

For example, if `parsed` is `unknown`, `const roles = (parsed as ModelPolicy).roles.research` uses `roles` without establishing that `parsed` is a model policy: report that missing validation and its consequence. By contrast, `Value.Check(ModelPolicySchema, parsed)` followed by `Value.Decode(ModelPolicySchema, parsed) as ModelPolicy` establishes the consumed shape; the remaining cast alone is not a finding. If a deterministic lint rule already catches an expression, report it only when you can identify a distinct underlying risk.

For each violation, name the unsupported claim, the first unsafe use, the missing check or contract, and a sound correction grounded in the surrounding code.
