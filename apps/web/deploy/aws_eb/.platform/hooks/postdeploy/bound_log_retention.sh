#!/bin/bash
set -euo pipefail
# Bounds the instance's log retention by time as well as by size.
#
# The platform provisions one logrotate fragment per log it rotates and runs
# each from its own hourly cron job. Those fragments trigger on size alone, so
# a log that fills slowly keeps its rotated copies for as long as it takes to
# reach that size, with no bound in time. This rewrites the rotation
# directives of the fragments named below -- a daily trigger, a kept-copy
# count, a maximum age -- and copies every other directive the platform wrote
# (the log paths, `olddir`, `compress`, `copytruncate`) through unchanged.
#
# The fragments exist only on the instance, so the rewritten fragment is
# checked there, by the platform's own logrotate, before it is installed: when
# logrotate rejects it the hook fails the deployment rather than installing it.
#
# An application deployment and a configuration-only deployment run separate
# hook trees, so this script is deployed twice, byte-identical, as
# .platform/hooks/postdeploy/bound_log_retention.sh and
# .platform/confighooks/postdeploy/bound_log_retention.sh. Edit both copies
# together.

RETENTION_DAYS=90
# A record waits in the live log until the next daily rotation, so the rotated
# copies hold a day less than the window to keep the oldest record inside it.
ROTATED_DAYS=$((RETENTION_DAYS - 1))

# The platform runs this with no arguments; directory arguments point the same
# rewrite at fixture fragments under test.
conf_dirs=("$@")
if [ "${#conf_dirs[@]}" -eq 0 ]; then
    conf_dirs=(/etc/logrotate.elasticbeanstalk.hourly /etc/logrotate.d)
fi

fragments=(
    logrotate.elasticbeanstalk.nginx.conf
    logrotate.elasticbeanstalk.web-stdout.conf
    logrotate.elasticbeanstalk.web-stderr.conf
)

# The directives this script owns. Everything outside this set belongs to the
# platform and has to survive the rewrite untouched.
managed='^[[:space:]]*(hourly|daily|weekly|monthly|yearly|size|minsize|maxsize|rotate|maxage)([[:space:]]|$)'
size_prefix='^[[:space:]]*(max)?size[[:space:]]+'
size_only="${size_prefix}[0-9]+[kKmMgG]?[[:space:]]*\$"

find_fragment() {
    local name="$1" dir
    for dir in "${conf_dirs[@]}"; do
        if [ -f "$dir/$name" ]; then
            printf '%s\n' "$dir/$name"
            return 0
        fi
    done
    return 1
}

bound_fragment() {
    local fragment="$1" rewritten state
    rewritten=$(mktemp)
    # Each block has its own size trigger, so the directives go in at the
    # block's closing brace, once that block's own size has been read.
    awk -v managed="$managed" -v size_prefix="$size_prefix" \
        -v size_only="$size_only" -v rotated="$ROTATED_DAYS" '
        /\{[[:space:]]*$/ && !in_block { in_block = 1; size = "" }
        in_block && $0 ~ size_only {
            size = $0
            sub(size_prefix, "", size)
            sub(/[[:space:]]*$/, "", size)
        }
        $0 ~ managed { next }
        in_block && /^[[:space:]]*\}[[:space:]]*$/ {
            print "    daily"
            if (size != "") print "    maxsize " size
            print "    rotate " rotated
            print "    maxage " rotated
            in_block = 0
        }
        { print }
    ' "$fragment" >"$rewritten"

    if ! diff -q \
        <(grep -Ev "$managed" "$fragment") \
        <(grep -Ev "$managed" "$rewritten") >/dev/null; then
        echo "Log retention: rewriting $fragment changed a directive this hook does not own; leaving it alone" >&2
        rm -f "$rewritten"
        exit 1
    fi

    if command -v logrotate >/dev/null 2>&1; then
        state=$(mktemp)
        if ! logrotate --debug --state "$state" "$rewritten" >/dev/null; then
            echo "Log retention: logrotate rejected the bounded $fragment; leaving it alone" >&2
            rm -f "$rewritten" "$state"
            exit 1
        fi
        rm -f "$state"
    else
        echo "Log retention: no logrotate on this host, installing $fragment without checking it" >&2
    fi

    if ! cmp -s "$rewritten" "$fragment"; then
        cat "$rewritten" >"$fragment"
        echo "Log retention: bounded $fragment at $RETENTION_DAYS days"
    fi
    rm -f "$rewritten"
}

missing=()
for name in "${fragments[@]}"; do
    if fragment=$(find_fragment "$name"); then
        bound_fragment "$fragment"
    else
        missing+=("$name")
    fi
done

if [ "${#missing[@]}" -gt 0 ]; then
    echo "Log retention: found no ${missing[*]} under ${conf_dirs[*]}, so those logs keep rotated copies with no time bound. Check what the platform provisions and update the fragment names in this hook." >&2
    exit 1
fi
