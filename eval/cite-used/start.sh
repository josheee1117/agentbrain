#!/bin/bash
# 两个并发：glm 先 on 后 off，ds 先 off 后 on（交替抵消时段差）
cd /private/tmp/cite-eval
nohup bash -c 'python3 harness/run_pi.py glm on; python3 harness/run_pi.py glm off' > runs/lane-glm.out 2>&1 </dev/null &
echo glm $!
nohup bash -c 'python3 harness/run_pi.py ds off; python3 harness/run_pi.py ds on' > runs/lane-ds.out 2>&1 </dev/null &
echo ds $!
