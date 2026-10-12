-- "Selecta Latest" in ~/Applications, compiled by `latest.sh install-app`. It runs latest.sh
-- one step at a time, so the progress window can say which, and asks where the terminal would.
property script_ : "__SCRIPT__"
property logFile : ""

on run
	set logFile to (POSIX path of (path to home folder)) & "Library/Logs/Selecta/launcher.log"
	do shell script "mkdir -p \"$(dirname " & quoted form of logFile & ")\" && echo \"--- $(date)\" >> " & quoted form of logFile
	set progress description to "Selecta"
	set progress total steps to 6
	set progress completed steps to 0

	set facts to runStep("check", "Checking for updates")
	set behindCount to (valueOf("behind", facts)) as integer
	set reason to ""
	if valueOf("branch", facts) is not "main" then
		set reason to "is on " & valueOf("branch", facts) & ", not main"
	else if valueOf("dirty", facts) is "1" then
		set reason to "has uncommitted changes"
	else if (valueOf("ahead", facts) as integer) > 0 and behindCount > 0 then
		set reason to "has commits origin/main doesn't, so it can't fast-forward"
	end if
	if reason is not "" then
		display dialog "Your selecta checkout " & reason & ", so it stays as it is." buttons {"Cancel", "Open As Is"} default button 2 with title "Selecta Latest" with icon caution
		set behindCount to 0
	end if

	if valueOf("metrognome", facts) is "outdated" then runStep("metrognome", "Upgrading metrognome")
	if valueOf("running", facts) is "1" then
		if behindCount is 0 and valueOf("built", facts) is "1" then
			runStep("open", "Opening Selecta")
			return
		end if
		set choice to button returned of (display dialog "Selecta is open and there's something newer. Close it and reopen on the latest?" buttons {"Keep Open", "Reopen"} default button 2 with title "Selecta Latest")
		if choice is "Keep Open" then
			runStep("open", "Opening Selecta")
			return
		end if
		runStep("stop", "Closing Selecta")
	end if

	if behindCount is 1 then
		runStep("pull", "Pulling 1 new commit")
	else if behindCount > 1 then
		runStep("pull", "Pulling " & behindCount & " new commits")
	end if
	runStep("install", "Checking dependencies")
	runStep("build", "Building Selecta")
	runStep("open", "Opening Selecta")
end run

-- Runs one step in the background, showing its latest output line until it exits.
on runStep(stepName, label)
	set progress additional description to label & "…"
	set outFile to do shell script "mktemp -t selecta-latest"
	set codeFile to outFile & ".code"
	set inner to quoted form of script_ & " " & stepName & " > " & quoted form of outFile & " 2>&1 < /dev/null; echo $? > " & quoted form of (codeFile & ".tmp") & "; mv " & quoted form of (codeFile & ".tmp") & " " & quoted form of codeFile
	-- Its own process group, so Stop takes npm, the build and everything else it started.
	set pid to do shell script "perl -e 'setpgrp(0, 0); exec @ARGV' /bin/sh -c " & quoted form of inner & " > /dev/null 2>&1 & echo $!"
	try
		repeat until (do shell script "test -f " & quoted form of codeFile & " && echo y || echo n") is "y"
			set lastLine to do shell script "tail -n 1 " & quoted form of outFile & " | cut -c 1-90"
			-- check prints facts, not progress.
			if lastLine is not "" and lastLine is not label and stepName is not "check" then set progress additional description to label & "…" & return & lastLine
			delay 0.3
		end repeat
	on error number -128
		do shell script "kill -TERM -- -" & pid & " 2> /dev/null; true"
		error number -128
	end try
	set code to do shell script "cat " & quoted form of codeFile
	set output to do shell script "cat " & quoted form of outFile
	do shell script "cat " & quoted form of outFile & " >> " & quoted form of logFile & "; rm -f " & quoted form of outFile & " " & quoted form of codeFile
	set progress completed steps to (progress completed steps) + 1
	if code is not "0" then
		set tailText to do shell script "tail -n 12 " & quoted form of logFile
		set choice to button returned of (display dialog label & " failed:" & return & return & tailText buttons {"Show Log", "OK"} default button 2 with title "Selecta Latest" with icon stop)
		if choice is "Show Log" then do shell script "open -a Console " & quoted form of logFile
		error number -128
	end if
	return output
end runStep

on valueOf(k, facts)
	repeat with ln in paragraphs of facts
		set s to contents of ln
		if s starts with (k & "=") and (length of s) > (length of k) + 1 then return text ((length of k) + 2) thru -1 of s
	end repeat
	return ""
end valueOf
