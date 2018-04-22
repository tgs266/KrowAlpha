"use strict";

var MAX_SKILLS = 30;
var MAX_EDUCATION = 15;
var MAX_EXPERIENCE = 20;
var MAX_ACHIEVEMENTS = 15;
var MAX_AFFILIATIONS = 5;

/**
 * @param {network.krow.transactions.applicant.UpdateApplicant} tx
 * @transaction
 */
async function UpdateApplicant(tx)
{
	var factory = getFactory();
	var applicant = tx.applicant;
	var upd = tx.updateApplicant;

	var copyfield = [
		"firstName",
		"lastName",
		"country",
		"state",
		"city",
		"address",
		"email",
		"phoneNumber",
		"links"
	];

	for (var i = 0, len = copyfield.length; i < len; i++)
	{
		var c = copyfield[i];
		if(upd[c] !== undefined)
			applicant[c] = upd[c];
	}

	//thrown, not returned
	validateModifyEntity(applicant);
	validateModifyResume(applicant.resume);

	if(!NAME_REGEX.test(applicant.firstName))
		throw new RestError(errno.EINVAL, "Invalid firstName: " + applicant.firstName);
	applicant.firstName = applicant.firstName.trim();

	if(!NAME_REGEX.test(applicant.lastName))
		throw new RestError(errno.EINVAL, "Invalid lastName: " + applicant.lastName);
	applicant.lastName = applicant.lastName.trim();

	applicant.lastUpdated = new Date();

	var applicantRegistry = await getParticipantRegistry('network.krow.participants.Applicant');
	await applicantRegistry.update(applicant);

	var event = factory.newEvent("network.krow.transactions.applicant", "UpdateApplicantEvent");
	event.applicant = applicant;
	emit(event);
}

/**
 * @param {network.krow.transactions.applicant.UpdateResume} tx
 * @transaction
 */
async function UpdateResume(tx)
{
	var factory = getFactory();
	var applicant = tx.applicant;
	var resume = tx.resume;

	var copyfield = [
		"education",
		//"skills",
		"experience",
		"achievements",
		"affiliations",
		"biography"
	];

	for (var i = 0, len = copyfield.length; i < len; i++)
	{
		var c = copyfield[i];
		if(resume[c] !== undefined)
			applicant.resume[c] = resume[c];
	}

	//handle skills separately so applicant can't modify endorsement rating
	if(resume.skills !== undefined)
	{
		if(resume.skills.length > MAX_SKILLS)
			throw new RestError(errno.ELIMIT, "Too many skill entries (max " + MAX_SKILLS + ")");

		//add skills
		for (var i = 0; i < resume.skills.length; i++)
		{
			var skill = resume.skills[i];
			var hasSkill = false;

			for (var j = 0; j < applicant.resume.skills.length; j++)
			{
				var appskill = applicant.resume.skills[j];

				if(skill.title == appskill.title)
				{
					hasSkill = true;
					break;
				}
			}

			if(!hasSkill)
			{
				applicant.resume.skills.push(skill);
				continue;
			}
		}

		//remove skills
		for (var i = 0; i < applicant.resume.skills.length; i++)
		{
			var skill = applicant.resume.skills[i];
			var hasSkill = false;

			for (var j = 0; j < resume.skills.length; j++)
			{
				if(resume.skills[j].title == skill.title)
				{
					hasSkill = true;
					break;
				}
			}

			if(!hasSkill)
			{
				applicant.resume.skills.splice(i--, 1);
				continue;
			}
		}
	}

	//thrown, not returned
	validateModifyResume(applicant.resume);

	applicant.resume.lastUpdated = new Date();

	var applicantRegistry = await getParticipantRegistry('network.krow.participants.Applicant');
	await applicantRegistry.update(applicant);

	var event = factory.newEvent("network.krow.transactions.applicant", "UpdateResumeEvent");
	event.applicant = applicant;
	event.resume = resume;
	emit(event);
}

/**
 * @param {network.krow.transactions.applicant.RequestJob} tx
 * @transaction
 */
async function RequestJob(tx)
{
	var factory = getFactory();
	var applicant = tx.applicant;
	var job = tx.job;

	if(!jobAvailable(job))
		throw new RestError(errno.EUNAVAIL);

	var jobRegistry = await getAssetRegistry('network.krow.assets.Job');

	//check if applicant is currently denied a request
	if(job.deniedApplicants !== undefined && job.deniedApplicants.length > 0)
	{
		//update the denied applicants list
		var removed = updateDeniedApplicants(job);
		if(removed > 0)
			await jobRegistry.update(job);

		for (var i = 0; i < job.deniedApplicants.length; i++)
		{
			var denied = job.deniedApplicants[i];
			if(denied.applicantID == applicant.applicantID)
				throw new RestError(errno.EACCES, denied.applicantID + "," + denied.deniedDate + "," + denied.reason);
		}
	}

	if(job.applicantRequests === undefined)
		job.applicantRequests = [];

	if(applicant.requestedJobs === undefined)
		applicant.requestedJobs = [];

	for (var i = 0; i < applicant.requestedJobs.length; i++)
	{
		if(applicant.requestedJobs[i].jobID == job.jobID)
			throw new RestError(errno.EALREADY);
	}

	job.applicantRequests.push(factory.newRelationship("network.krow.participants", "Applicant", applicant.applicantID));
	applicant.requestedJobs.push(factory.newRelationship("network.krow.assets", "Job", job.jobID));

	await jobRegistry.update(job);

	var applicantRegistry = await getParticipantRegistry('network.krow.participants.Applicant');
	await applicantRegistry.update(applicant);

	var event = factory.newEvent("network.krow.transactions.applicant", "RequestJobEvent");
	event.applicant = applicant;
	event.job = job;
	emit(event);
}

/**
 * @param {network.krow.transactions.applicant.UnrequestJob} tx
 * @transaction
 */
async function UnrequestJob(tx)
{
	var factory = getFactory();
	var applicant = tx.applicant;
	var job = tx.job;

	if(!jobAvailable(job))
		throw new RestError(errno.EUNAVAIL);

	var jobRegistry = await getAssetRegistry('network.krow.assets.Job');

	//update denied applicants
	if(job.deniedApplicants !== undefined && job.deniedApplicants.length > 0)
	{
		//update the denied applicants list
		var removed = updateDeniedApplicants(job);
		if(removed > 0)
			await jobRegistry.update(job);
	}

	if(applicant.requestedJobs === undefined || job.applicantRequests === undefined || !job.applicantRequests.length)
		throw new RestError(errno.ENOLIST);

	var removed = false;

	for (var i = 0; i < applicant.requestedJobs.length; i++)
	{
		if(applicant.requestedJobs[i].jobID == job.jobID)
		{
			applicant.requestedJobs.splice(i, 1);
			removed = true;
			break;
		}
	}

	if(!removed)
		throw new RestError(errno.ENOLIST);

	for (var i = 0; i < job.applicantRequests.length; i++)
	{
		if(job.applicantRequests[i].applicantID == applicant.applicantID)
		{
			job.applicantRequests.splice(i, 1);
			break;
		}
	}

	if (applicant.hireRequests !== undefined)
	{
		for (var i = 0; i < applicant.hireRequests.length; i++)
		{
			if (applicant.hireRequests[i].jobID == job.jobID)
			{
				applicant.hireRequests.splice(i, 1);
				break;
			}
		}
	}

	await jobRegistry.update(job);

	var applicantRegistry = await getParticipantRegistry('network.krow.participants.Applicant');
	await applicantRegistry.update(applicant);

	var event = factory.newEvent("network.krow.transactions.applicant", "UnrequestJobEvent");
	event.applicant = applicant;
	event.job = job;
	emit(event);
}

/**
 * @param {network.krow.transactions.applicant.AcceptHire} tx
 * @transaction
 */
async function AcceptHire(tx)
{
	var factory = getFactory();
	var applicant = tx.applicant;
	var job = tx.job;

	var employer = job.employer;

	if(job.hireRequests === undefined)
		throw new RestError(errno.ENOLIST);

	var inlist = false;
	for (var i = 0; i < job.hireRequests.length; i++)
	{
		if(job.hireRequests[i].applicantID == applicant.applicantID)
		{
			inlist = true;
			break;
		}
	}

	if(!inlist || employer.availableJobs === undefined)
		throw new RestError(errno.ENOLIST);

	if(employer.inprogressJobs === undefined)
		employer.inprogressJobs = [];

	if(applicant.inprogressJobs === undefined)
		applicant.inprogressJobs = [];

	for (var i = 0; i < employer.availableJobs.length; i++)
	{
		if(employer.availableJobs[i].jobID == job.jobID)
		{
			employer.availableJobs.splice(i, 1);
			break;
		}
	}

	for (var i = 0; i < applicant.hireRequests.length; i++)
	{
		if (applicant.hireRequests[i].jobID == job.jobID)
		{
			applicant.hireRequests.splice(i, 1);
			break;
		}
	}

	if(applicant.requestedJobs !== undefined)
	{
		for (var i = 0; i < applicant.requestedJobs.length; i++)
		{
			if(applicant.requestedJobs[i].jobID == job.jobID)
			{
				applicant.requestedJobs.splice(i, 1);
				break;
			}
		}
	}

	var updateApplicants = [applicant];

	if(job.applicantRequests !== undefined)
	{
		for (var i = 0; i < job.applicantRequests.length; i ++)
		{
			var appl = job.applicantRequests[i];
			for (var j = 0; j < appl.requestedJobs.length; j++)
			{
				if(appl.requestedJobs[j].jobID == job.jobID)
				{
					appl.requestedJobs.splice(j, 1);
					break;
				}
			}

			updateApplicants.push(appl);
		}
	}

	job.applicantRequests = [];
	job.deniedApplicants = [];
	job.hireRequests = [];
	job.employee = factory.newRelationship("network.krow.participants", "Applicant", applicant.applicantID);
	job.startDate = new Date();
	job.flags |= JOB_ACTIVE;

	var jobRef = factory.newRelationship("network.krow.assets", "Job", job.jobID)
	employer.inprogressJobs.push(jobRef);
	applicant.inprogressJobs.push(jobRef);

	var jobRegistry = await getAssetRegistry('network.krow.assets.Job');
	await jobRegistry.update(job);

	var employerRegistry = await getParticipantRegistry('network.krow.participants.Employer');
	await employerRegistry.update(employer);

	var applicantRegistry = await getParticipantRegistry('network.krow.participants.Applicant');
	await applicantRegistry.updateAll(updateApplicants);

	var event = factory.newEvent("network.krow.transactions.applicant", "AcceptHireEvent");
	event.employer = employer;
	event.applicant = applicant;
	event.job = job;
	emit(event);
}

/**
 * @param {network.krow.transactions.applicant.ResignJob} tx
 * @transaction
 */
async function ResignJob(tx)
{
	var factory = getFactory();
	var applicant = tx.applicant;
	var job = tx.job;

	var employer = job.employer;

	if(job.employee.applicantID != applicant.applicantID || applicant.inprogressJobs === undefined || employer.inprogressJobs === undefined)
		throw new RestError(errno.ENOLIST);

	if((job.flags & JOB_ACTIVE) != JOB_ACTIVE)
		throw new RestError(errno.ENOACTIVE);

	for (var i = 0; i < applicant.inprogressJobs.length; i++)
	{
		if(applicant.inprogressJobs[i].jobID == job.jobID)
		{
			applicant.inprogressJobs.splice(i, 1);
			break;
		}
	}

	for (var i = 0; i < employer.inprogressJobs.length; i++)
	{
		if(employer.inprogressJobs[i].jobID == job.jobID)
		{
			employer.inprogressJobs.splice(i, 1);
			break;
		}
	}

	if(applicant.terminatedJobs === undefined)
		applicant.terminatedJobs = [];

	var jobRef = factory.newRelationship("network.krow.assets", "Job", job.jobID);
	applicant.terminatedJobs.push(jobRef);
	employer.availableJobs.push(jobRef);

	job.startDate = null;
	job.flags &= ~JOB_ACTIVE;
	job.employee = null;

	var jobRegistry = await getAssetRegistry('network.krow.assets.Job');
	await jobRegistry.update(job);

	var employerRegistry = await getParticipantRegistry('network.krow.participants.Employer');
	await employerRegistry.update(employer);

	var applicantRegistry = await getParticipantRegistry('network.krow.participants.Applicant');
	await applicantRegistry.update(applicant);

	var event = factory.newEvent("network.krow.transactions.applicant", "ResignJobEvent");
	event.employer = employer;
	event.applicant = applicant;
	event.job = job;
	emit(event);
}

/**
 * @param {network.krow.transactions.applicant.RequestCompleteJob} tx
 * @transaction
 */
async function RequestCompleteJob(tx)
{
	var factory = getFactory();
	var applicant = tx.applicant;
	var job = tx.job;

	if(applicant.applicantID != job.employee.applicantID)
		throw new RestError(errno.ERELATE);

	if((job.flags & JOB_ACTIVE) != JOB_ACTIVE)
		throw new RestError(errno.ENOACTIVE);

	job.flags |= JOB_REQUESTCOMPLETE;
	job.requestCompletedDate = new Date();

	var jobRegistry = await getAssetRegistry('network.krow.assets.Job');
	await jobRegistry.update(job);

	var event = factory.newEvent("network.krow.transactions.applicant", "RequestCompleteJobEvent");
	event.employer = job.employer;
	event.applicant = job.employee;
	event.job = job;
	emit(event);
}

/**
 * @param {network.krow.transactions.applicant.UnrequestCompleteJob} tx
 * @transaction
 */
async function UnrequestCompleteJob(tx)
{
	var factory = getFactory();
	var applicant = tx.applicant;
	var job = tx.job;

	if(applicant.applicantID != job.employee.applicantID)
		throw new RestError(errno.ERELATE);

	if((job.flags & JOB_ACTIVE) != JOB_ACTIVE || (job.flags & JOB_REQUESTCOMPLETE) != JOB_REQUESTCOMPLETE)
		throw new RestError(errno.ENOACTIVE);

	job.flags &= ~JOB_REQUESTCOMPLETE;
	job.requestCompletedDate = undefined;

	var jobRegistry = await getAssetRegistry('network.krow.assets.Job');
	await jobRegistry.update(job);

	var event = factory.newEvent("network.krow.transactions.applicant", "UnrequestCompleteJobEvent");
	event.employer = job.employer;
	event.applicant = job.employee;
	event.job = job;
	emit(event);
}

function validateModifyResume(resume)
{
	if(resume.education !== undefined)
	{
		if(resume.education.length > MAX_EDUCATION)
			throw new RestError(errno.ELIMIT, "Too many education entries (max " + MAX_EDUCATION + ")");

		for (var i = 0; i < resume.education.length; i++)
			validateModifyResumeItem(resume.education[i]);
	}

	if(resume.skills !== undefined)
	{
		if(resume.skills.length > MAX_SKILLS)
			throw new RestError(errno.ELIMIT, "Too many skill entries (max " + MAX_SKILLS + ")");

		for (var i = 0; i < resume.skills.length; i++)
		{
			var skill = resume.skills[i].skill;
			if(!NAME_REGEX.test(skill))
				throw new RestError(errno.EINVAL, "Invalid skill: " + skill);
			resume.skills[i].skill = skill.trim();
		}
	}

	if(resume.experience !== undefined)
	{
		if(resume.experience.length > MAX_EXPERIENCE)
			throw new RestError(errno.ELIMIT, "Too many experience entries (max " + MAX_EXPERIENCE + ")");

		for (var i = 0; i < resume.experience.length; i++)
		{
			validateModifyResumeItem(resume.experience[i]);

			if(resume.experience[i].position && !NAME_REGEX.test(resume.experience[i].position))
				throw new RestError(errno.EINVAL, "Invalid position: " + resume.experience[i].position);
		}
	}

	if(resume.achievements !== undefined)
	{
		if(resume.achievements.length > MAX_ACHIEVEMENTS)
			throw new RestError(errno.ELIMIT, "Too many achievement entries (max " + MAX_ACHIEVEMENTS + ")");

		for (var i = 0; i < resume.achievements.length; i++)
			validateModifyResumeItem(resume.achievements[i]);
	}

	if(resume.affiliations !== undefined)
	{
		if(resume.affiliations.length > MAX_AFFILIATIONS)
			throw new RestError(errno.ELIMIT, "Too many affiliation entries (max " + MAX_AFFILIATIONS + ")");

		for (var i = 0; i < resume.affiliations.length; i++)
			validateModifyResumeItem(resume.affiliations[i]);
	}

	return true;
}

function validateModifyResumeItem(item)
{
	if(!NAME_REGEX.test(item.title))
		throw new RestError(errno.EINVAL, "Invalid title: " + item.title);
	item.title = item.title.trim();

	if(!NAME_REGEX.test(item.description))
		throw new RestError(errno.EINVAL, "Invalid description: " + item.description);
	item.description = item.description.trim();

	var now = new Date();

	if(item.startDate !== undefined && item.startDate > now)
		throw new RestError(errno.EINVAL, "Invalid future date: " + item.startDate);

	if(item.endDate !== undefined)
	{
		if(item.endDate > now)
			throw new RestError(errno.EINVAL, "Invalid future date: " + item.endDate);
		if(item.startDate === undefined)
		{
			item.startDate = item.endDate;
		}else
		{
			if(item.endDate < item.startDate)
				throw new RestError(errno.EINVAL, "Invalid date range: " + item.startDate + ", " + item.endDate);
		}
	}

	return true;
}

function updateDeniedApplicants(job)
{
	var denied = job.deniedApplicants;
	var removed = 0;
	var date = new Date();

	for (var i = 0; i < denied.length; i++)
	{
		if(date - denied[i].deniedDate >= DENIED_EXPIRE)
		{
			denied.splice(i--, 1);
			removed++;
		}
	}

	return removed;
}
