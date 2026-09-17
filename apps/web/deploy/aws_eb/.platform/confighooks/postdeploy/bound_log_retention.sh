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
# (the log paths, `olddir`, `compress`, `copytruncate`, `minsize`) through
# unchanged.
#
# The fragments exist only on the instance, so the rewritten fragment is
# checked there before it is installed: every block of it has to come out
# holding the bound this hook writes, and the platform's own logrotate has to
# parse the result. A fragment failing either check fails the deployment
# rather than being installed.
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
# platform and has to survive the rewrite untouched, `minsize` included: it
# holds a floor under rotation rather than a trigger this hook replaces.
managed='^[[:space:]]*(hourly|daily|weekly|monthly|yearly|size|maxsize|rotate|maxage)([[:space:]]|$)'
other_interval='^[[:space:]]*(hourly|weekly|monthly|yearly)([[:space:]]|$)'
size_prefix='^[[:space:]]*(max)?size[[:space:]]+'
size_only="${size_prefix}[0-9]+[kKmMgG]?[[:space:]]*(#.*)?\$"
# A brace takes trailing whitespace and a trailing comment, and a block whose
# close is not recognized loses its directives without gaining the bound.
open_brace='\{[[:space:]]*(#.*)?$'
close_brace='^[[:space:]]*\}[[:space:]]*(#.*)?$'

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

# Reads the fragment as the platform wrote it and the rewrite beside it, and
# holds every block of the rewrite to the bound: one daily trigger and no
# other, one `rotate` and one `maxage` at the day count, and a `maxsize` for
# exactly those blocks the platform gave a size trigger.
check_bounded() {
    local fragment="$1" rewritten="$2"
    awk -v fragment="$fragment" -v rotated="$ROTATED_DAYS" \
        -v size_only="$size_only" -v other_interval="$other_interval" \
        -v open_brace="$open_brace" -v close_brace="$close_brace" '
        function trim(line) {
            sub(/^[[:space:]]+/, "", line)
            sub(/[[:space:]]+$/, "", line)
            return line
        }
        function complain(block, reason) {
            printf "Log retention: the bounded %s leaves `%s` %s; leaving it alone\n", \
                fragment, block, reason > "/dev/stderr"
            failed = 1
        }
        FNR == 1 { pass++; in_block = 0; block_no = 0 }
        pass == 1 {
            if (!in_block && $0 ~ open_brace) {
                in_block = 1
                blocks++
                opening[blocks] = trim($0)
                sized[blocks] = 0
            } else if (in_block && $0 ~ close_brace) {
                in_block = 0
            } else if (in_block && $0 ~ size_only) {
                sized[blocks] = 1
            }
            next
        }
        !in_block && $0 ~ open_brace {
            in_block = 1
            block_no++
            n_daily = 0
            n_other = 0
            n_rotate = 0
            n_rotate_bound = 0
            n_maxage = 0
            n_maxage_bound = 0
            n_maxsize = 0
            next
        }
        in_block && $0 ~ close_brace {
            in_block = 0
            if (block_no > blocks) {
                complain(trim($0), "in a block the fragment did not open")
            } else if (n_daily != 1 || n_other != 0 || n_rotate != 1 ||
                       n_rotate_bound != 1 || n_maxage != 1 ||
                       n_maxage_bound != 1 || n_maxsize != sized[block_no]) {
                complain(opening[block_no], "without the bound this hook writes")
            }
            next
        }
        in_block {
            if ($0 ~ /^[[:space:]]*daily([[:space:]]|$)/) n_daily++
            if ($0 ~ other_interval) n_other++
            if ($0 ~ /^[[:space:]]*rotate([[:space:]]|$)/) n_rotate++
            if ($0 ~ "^[[:space:]]*rotate[[:space:]]+" rotated "[[:space:]]*$") n_rotate_bound++
            if ($0 ~ /^[[:space:]]*maxage([[:space:]]|$)/) n_maxage++
            if ($0 ~ "^[[:space:]]*maxage[[:space:]]+" rotated "[[:space:]]*$") n_maxage_bound++
            if ($0 ~ /^[[:space:]]*maxsize([[:space:]]|$)/) n_maxsize++
            next
        }
        END {
            if (blocks == 0) {
                printf "Log retention: %s holds no rotation block to bound; leaving it alone\n", \
                    fragment > "/dev/stderr"
                failed = 1
            } else if (in_block) {
                complain(opening[block_no], "unclosed")
            } else if (block_no != blocks) {
                complain(opening[block_no + 1], "unbounded")
            }
            if (failed) exit 1
        }
    ' "$fragment" "$rewritten"
}

bound_fragment() {
    local fragment="$1" rewritten state
    rewritten=$(mktemp)
    # Each block has its own size trigger, so the directives go in at the
    # block's closing brace, once that block's own size has been read.
    awk -v managed="$managed" -v size_prefix="$size_prefix" \
        -v size_only="$size_only" -v open_brace="$open_brace" \
        -v close_brace="$close_brace" -v rotated="$ROTATED_DAYS" '
        !in_block && $0 ~ open_brace { in_block = 1; size = "" }
        in_block && $0 ~ size_only {
            size = $0
            sub(size_prefix, "", size)
            sub(/[[:space:]]*(#.*)?$/, "", size)
        }
        in_block && $0 ~ managed { next }
        in_block && $0 ~ close_brace {
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

    if ! check_bounded "$fragment" "$rewritten"; then
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
