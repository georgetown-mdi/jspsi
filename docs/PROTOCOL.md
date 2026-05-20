---
title: "PSI-Link Protocol"
---

# PSI-Link protocol

This document describes the PSI and PSI-C algorithms and how they are composed
to produce a privacy-preserving record linkage. It does not cover the exchange
agreement format that parameterizes the protocol (see
[EXCHANGE_SPEC.md](EXCHANGE_SPEC.md)), the threat model (see
[SECURITY.md](SECURITY.md)), or the network layer over which the protocol runs
(see [COMMUNICATION.md](COMMUNICATION.md)). Intended readers are security
auditors, external implementors, and developers.

# Privacy preserving record linkage

The PPRL protocol utilizes a base PSI function to repeatedly reveal the size of the sets of shared statistical linkage keys. This reveals to the parties an association map between their shared members and nothing about elements they do not have in common.

## PSI base function

The PSI base function is a lightly modified version of OpenMined's [PSI](https://github.com/OpenMined/PSI). That package implements private set intersection layering over the encryption in Google's [Private Join and Compute](https://github.com/Google/private-join-and-compute) (itself using OpenSSL), written in C++ that is compiled into WebAssembly. The base function divides the two participants into "server" and a "client" roles. At a high level, the steps of the protocol are:

1. Both client and server generate their own private keys which live only in memory for the duration of the exchange. Keys are random scalars in the P-256 elliptic curve group and are generated using OpenSSL.
2. The client initializes the exchange by encrypting their own data with their own private key using a commutative encryption algorithm and then sends it to the server.
3. The server commutatively encrypts both their own data and the client's data with their own private key and then sends both datasets to the client.
4. The client can then remove their own key from their own data, leaving them with client and server datasets encrypted only by the server.
5. A straightforward string comparison allows the client to see which elements they have in common. They can then choose to share the association table back with the server.

The terminology of "server" and "client" derives from OpenMined's PSI implementation and is used here to be consistent with their documentation. However, "server" and "client" are disfavored throughout the rest of this project as there are many other instances of servers and clients, and OpenMined's PSI includes no networking coding. Most often we will want to execute the protocol so that both parties learn the outcome. When it is necessary to distinguish between the two roles, we will instead use *receiver* and *sender* respectively. When only one party receives output, that party's role is fixed as the receiver. When both parties receive output, roles are assigned dynamically: the party with the smaller dataset becomes the receiver (minimising data transmitted); ties are broken in favour of the initiator becoming the receiver.

## Linkage keys

Statistical linkage keys are data elements that combine several other inputs into a single value that uniquely represents an individual with an extremely high probability. In this application, the most common data types for linkage keys are social security number, first name, last name, and date of birth. An example linkage key is the last four digits of the social security number concatenated with last name and date-of-birth as a character string.

Linkage keys can be designed to produce links even in the place of data quality errors, for instance by exhaustively generating all transpositions of two digits in a Social Security Number (SSN) or comparing all single-character edits of strings of a fixed length. By repeatedly executing the PSI base function on such keys, two parties execute a fuzzy PPRL. 

In order to preserve the guarantee that no information is revealed about individuals not in the intersection, linkage keys must be designed to be precise enough (high positive-predictive value) that any match is definitive.

## Matching Algorithms

### PSI

The way in which links are decided depends on whether or not both parties will receive output. If so, then they can communicate directly with each other and optimize the procedure. For one-to-one mappings, linkage keys are applied in sequence forming a cascade of deterministic matches: keys are ordered from most to least precise, and at each round only records that match uniquely on that key are accepted as pairs and removed from the candidate set - the pool of records not yet definitively matched. Inputs without a match or without a unique linkage key carry forward to the next round. If only one party receives the output, then that party must send and receive all of both datasets every round in order to avoid leaking information about the number of matched elements. It must also keep track of the association map on its own in order to enforce a one-to-one mapping.

In linkages that involve multiple links - either many-to-one or many-to-many - the multiplicity is resolved into single entity clusters by applying a transitive closure algorithm. Transitive closure may create scenarios where two members are linked through a third record without a rule linking them directly, so careful consideration of linkage keys and their consequences is required. Having an output that includes multiple links per input implies that some meaning is imparted to the data holder through entity resolution; as such, these exchanges require that the "many" parties receive the output. In order to communicate this effectively to users, rather than describe the multiplicity of the exchange they are asked if they want to *deduplicate* their data, as they effectively use their partner's data to group their own.

In a many-to-one exchange where both parties receive the output, the "many" party can filter its candidate set to remove linked elements after each round similar to the deterministic cascade used in a one-to-one linkage. If the "one" party is not allowed to receive the output, the "many" party must ensure the uniqueness constraint.

Crucially, unlike traditional PPRL, blocking when using PSI is neither necessary nor appropriate. The PSI base function's computational complexity is O(n log n) in the total number of elements rather than quadratic in their product, so there is no cross-product comparison to reduce. Blocking would also compromise the privacy guarantee by revealing to each party how many of the other's records fall into each partition.

The practical upper limit on the number of records for browser-based execution is determined by available memory rather than computation: each encrypted element occupies roughly 64 bytes, so holding both parties' encrypted sets simultaneously for the comparison step requires on the order of 1-2 GB for datasets in the tens of millions of rows - well within the capacity of a modern workstation. The only part of the algorithm that requires WebAssembly is the application of the commutative encryption algorithm, which can be streamed and parallelized over the data.

### PSI-C

PSI-C is also executed by sequentially executing deterministic linkages. Membership anonymity is granted by the sender permuting the receiver's doubly-encrypted data before returning it to them. The results of multiple linkage keys can be combined so long as the sender uses a consistent permutation algorithm for each round. The association map in the permuted space has the same size as one in the original space. This allows the cardinality to be measured without revealing which specific members are in common.

# Datasets

## Raw data

Data is input as a csv or other tabular data format. These files include rough metadata such as column names and storage types, which can be augmented with [metadata](EXCHANGE_SPEC.md#input-metadata) from the exchange specification. Thus raw data consists of one or more columns, metadata for each column, and a record count.

## Standardized data

A standardized dataset bridges between raw data and the fields expected as inputs to linkage keys. It is an abstraction over the application of [data standardizing](EXCHANGE_SPEC.md#data-standardizing-transformations) transformations. As noted in that section, there can be zero, one, or more than one standardized record for any input, so a standardized data element is essentially a mapping between an index into the raw dataset and a set of strings. These mappings are lazily evaluated and their results are cached. A standardized dataset is a collection of these mappings and the names of the linkage key fields they provide.

## Key input data

As defined in [linkage terms](EXCHANGE_SPEC.md#linkage-terms), linkage fields are the inputs that are typically transformed to create the character strings that are concatenated to form statistical linkage keys. The linkage algorithm attempts to connect individuals - not just character strings - represented by their indices in the original dataset. Consequently, key inputs are realizations of linkage fields and are, like standardized data elements, maps between indices and sets of character strings of arbitrary size. In order to realize a complete linkage key, the set of all combinations of all key inputs is computed each and each combination is concatenated together into a string.

When that set has zero elements, i.e. one of the elements is `NULL`, it is omitted from the linkage protocol. When that set has more than one element and the algorithm is using the optimization implied by the deterministic cascade detailed in [Matching algorithms](#psi), communication is required in order to determine if the link is unique. For example, if one party has a member named "Mary Shaye-Smith" and another two members named "Mary Thorne" and "Mary Smith", unless the mapping was many-to-one it would be incorrect to accept both matches as valid and remove the individuals from the candidate set.

This extra communication step violates the threat model which guarantees that nothing can be learned about members that are not in common. That said, the existence of a match on a key would be sufficient evidence that two records represent the same person and it is only by revealing contradictory evidence that the link is not made. Users who employ these transformations are warned about their consequences.

# Post-linkage steps

## Non-repudiation

At the conclusion of a successful exchange but before the association map is shared, both parties sign a receipt recording the timestamp, a hash of the exchange agreement, the identities of both parties, and the size of the result if that information was learned by both parties. They then exchange these signatures. Each party retains the other's signature as cryptographic evidence that the exchange occurred. Each party can sign the exchange receipt using either a session-derived key - sufficient for the parties' own records but not independently verifiable by outsiders - or a certificate-authority-backed private key, which allows auditors or legal bodies to verify the signatures without any prior knowledge of the exchange.

Catastrophic failure to exchange receipts results in termination of the program and the exchange must be restarted. As above, dropped connections are retried and undelivered messages are attempted again.

Retention, access controls, and log integrity beyond the receipt remain each party's internal compliance obligation.

## Output

The basic output is an association table between each party's element. As noted above, if parties supplied identifier columns with their inputs and flagged them in their metadata, the association table will be between each party's identifiers. Otherwise, the table references the row indices of each dataset.

If parties elected to transmit payload data, the relevant columns for the appropriate rows will be transmitted in-band over the secure connection and appended to the output in-the-clear.

## See also

- [EXCHANGE_SPEC.md](EXCHANGE_SPEC.md) - exchange agreement format that parameterizes the protocol described here
- [SECURITY.md](SECURITY.md) - threat model and security properties of the protocol
- [COMMUNICATION.md](COMMUNICATION.md) - network channels over which the protocol runs
- [DESIGN.md](DESIGN.md) - high-level overview, architecture, and possible extensions
