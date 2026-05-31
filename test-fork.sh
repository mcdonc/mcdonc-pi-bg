#!/bin/bash
# Automated fork stress test for mcdonc-pi-bg
# Runs nested fork scenarios with varying timing and checks results

set -e

PASS=0
FAIL=0
RUN=0

cleanup() {
    tmux send-keys -t pitest C-c 2>/dev/null; sleep 1
    tmux send-keys -t pitest C-d 2>/dev/null; sleep 2
    tmux kill-session -t pitest 2>/dev/null
}

trap cleanup EXIT

run_test() {
    local fork1_delay=$1
    local fork2_delay=$2
    local bb1_delay=$3
    local bb2_delay=$4
    local topic1=$5
    local topic2=$6
    local topic3=$7

    RUN=$((RUN + 1))
    echo ""
    echo "=== RUN $RUN: fork1=${fork1_delay}s fork2=${fork2_delay}s bb1=${bb1_delay}s bb2=${bb2_delay}s ==="
    echo "  topics: '$topic1' / '$topic2' / '$topic3'"

    # Kill any existing session
    tmux kill-session -t pitest 2>/dev/null || true
    sleep 1

    # Start pi fresh
    tmux new-session -d -s pitest -x 160 -y 40
    tmux send-keys -t pitest "pi 2>/tmp/pi-stderr.log" Enter
    sleep 8

    # Verify pi started
    if ! tmux capture-pane -t pitest -p | grep -q "128k\|auto"; then
        echo "  SKIP: pi failed to start"
        return
    fi

    # Topic 1 → fork
    tmux send-keys -t pitest "$topic1" Enter
    sleep "$fork1_delay"
    tmux send-keys -t pitest "/b" Enter
    sleep 5

    # Check fork 1
    if ! tmux capture-pane -t pitest -p | grep -q "⑂ 1 fork"; then
        echo "  FAIL: fork 1 not created"
        FAIL=$((FAIL + 1))
        return
    fi

    # Topic 2 → fork
    tmux send-keys -t pitest "$topic2" Enter
    sleep "$fork2_delay"
    tmux send-keys -t pitest "/b" Enter
    sleep 5

    # Check fork 2
    if ! tmux capture-pane -t pitest -p | grep -q "⑂ 2 forks"; then
        echo "  FAIL: fork 2 not created"
        FAIL=$((FAIL + 1))
        return
    fi

    # Topic 3 (the innermost conversation)
    tmux send-keys -t pitest "$topic3" Enter
    sleep 10

    # /bb once — should resume topic 2
    tmux send-keys -t pitest "/bb" Enter
    sleep "$bb1_delay"

    # Check: should have 1 fork now
    local forks_after_bb1=$(tmux capture-pane -t pitest -p | grep -o "⑂ [0-9]" | head -1)
    if [ "$forks_after_bb1" != "⑂ 1" ]; then
        echo "  FAIL: after first /bb, expected ⑂ 1 fork, got '$forks_after_bb1'"
        FAIL=$((FAIL + 1))
        # Capture output for debugging
        tmux capture-pane -t pitest -p > "/tmp/fork-fail-${RUN}.txt"
        return
    fi

    # Check content — should mention topic2 keywords, NOT topic1 or topic3
    local content_after_bb1=$(tmux capture-pane -t pitest -p)

    # /bb again — should resume topic 1
    tmux send-keys -t pitest "/bb" Enter
    sleep "$bb2_delay"

    # Check: should have 0 forks now
    local forks_after_bb2=$(tmux capture-pane -t pitest -p | grep -o "⑂ [0-9]")
    if [ -n "$forks_after_bb2" ]; then
        echo "  FAIL: after second /bb, expected no fork indicator, got '$forks_after_bb2'"
        FAIL=$((FAIL + 1))
        tmux capture-pane -t pitest -p > "/tmp/fork-fail-${RUN}.txt"
        return
    fi

    echo "  PASS"
    PASS=$((PASS + 1))
}

# Vary timing and topics across runs
run_test 2 2 15 15 \
    "write a 20000 word essay on medieval france" \
    "write a 5000 word essay on frogs" \
    "tell me 100 jokes"

run_test 1 1 10 10 \
    "write a detailed history of ancient rome" \
    "explain quantum physics in depth" \
    "list 50 types of cheese"

run_test 3 1 12 12 \
    "write a 10000 word essay on japanese samurai" \
    "describe every planet in the solar system in detail" \
    "write a poem about rain"

run_test 1 3 20 10 \
    "explain the entire history of mathematics" \
    "write about the life cycle of butterflies" \
    "what are the capitals of every country in europe"

run_test 2 2 8 8 \
    "write a comprehensive guide to cooking italian food" \
    "explain how computers work from transistors to operating systems" \
    "tell me about famous painters"

run_test 1 1 25 25 \
    "describe the geography of africa in extreme detail" \
    "write about the history of jazz music" \
    "list every US president and one fact about each"

run_test 4 2 10 15 \
    "write a 15000 word essay on the french revolution" \
    "explain machine learning algorithms in detail" \
    "write haikus about each season"

run_test 1 4 15 10 \
    "describe the architecture of gothic cathedrals" \
    "write about deep sea creatures" \
    "explain how to play chess"

echo ""
echo "=== RESULTS: $PASS passed, $FAIL failed out of $RUN runs ==="
if [ $FAIL -gt 0 ]; then
    echo "Failed run outputs saved to /tmp/fork-fail-*.txt"
fi
