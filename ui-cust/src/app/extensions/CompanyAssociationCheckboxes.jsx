import React, { useEffect, useState } from 'react';
import { hubspot, Text, Box, Button, Checkbox, Flex } from '@hubspot/ui-extensions';

hubspot.extend(({ context, actions }) => (
    <CompanyAssociationCheckboxes context={context} actions={actions} />
));

function CompanyAssociationCheckboxes({ context, actions }) {
    const [companies, setCompanies] = useState([]);
    const [selectedCompanies, setSelectedCompanies] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    // const [accessToken, setAccessToken] = useState('');

    const contactId = context?.crm?.objectId;
    // console.log('context:', context);
    useEffect(() => {
        console.log('contactId:', contactId);
        if (!contactId) actions.addAlert('No contact ID found in context');
        const fetchData = async () => {
            try {
                // console.log('getting access token');
                // let data = await hubspot.fetch('https://us-central1-hubspot-fetch.cloudfunctions.net/app/get-access-token', {
                //     method: 'GET',  
                // });
                // data = await data.json();
                // if (!data.accessToken) throw new Error('Failed to get access token');
                // console.log('accessToken', data.accessToken);
                console.log('starting fetch');
                const companiesResponse = await hubspot.fetch('https://us-central1-hubspot-fetch.cloudfunctions.net/app/companies', {
                    method: 'GET',
                });
                
                // console.log(companiesResponse); 
                // if (!companiesResponse.ok) throw new Error('Failed to load companies');
                const companiesData = await companiesResponse.json();
                console.log(companiesData);
                // setAccessToken(data.accessToken);
                const associationsResponse = await hubspot.fetch(`https://us-central1-hubspot-fetch.cloudfunctions.net/app/associations/${contactId}`, {
                    method: 'GET',
                    // headers: {
                    //     Authorization: `Bearer ${data.accessToken}`,
                    // },
                });
                if (!associationsResponse.ok) throw new Error('Failed to load associations');
                const associationsData = await associationsResponse.json();
                console.log(associationsData);
                // console.log(companiesData.results[0].name);
                setCompanies(companiesData.results);
                setSelectedCompanies(associationsData.map(a => a.toObjectId)); // Adjusted to use correct company ID property
            } catch (error) { 
                console.error(error);
                actions.addAlert({ message: error.message, type: 'danger' });
            } finally {
                setIsLoading(false);
            }
        };

        if (contactId) fetchData();
    }, [contactId, actions]);

    const handleCheckboxChange = (companyId) => {
        setSelectedCompanies(prev => 
            prev.includes(companyId) 
                ? prev.filter(id => id !== companyId) 
                : [...prev, companyId]
        );
    };

    const handleSave = async () => {
        setIsSaving(true);
        try {
            console.log('saving associations');
            // console.log(accessToken);
            // console.log(selectedCompanies);
            const requestBody = {
                "contactId": contactId,
                "companyIds": selectedCompanies,
            };
            console.log(requestBody);
            await hubspot.fetch(`https://us-central1-hubspot-fetch.cloudfunctions.net/app/save-associations`, {
                method: 'POST',
                // headers: {
                //     // 'Content-Type': 'application/json',
                //     Authorization: `Bearer ${accessToken}`,
                // },
                body: requestBody,
            });
            actions.addAlert({ message: 'Associations saved successfully!', type: 'SUCCESS' });
        } catch (error) {
            console.log(error);
            actions.addAlert({ message: 'Failed to save associations', type: 'ERROR' });
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <Box padding="medium" spacing="small">
            <Text variant="heading3">Associated Companies</Text>
            {isLoading ? (
                <Text>Loading companies...</Text>
            ) : companies.length === 0 ? (
                <Text>No companies available to associate.</Text>
            ) : (
                <>
                    <Box maxHeight="200px" overflowY="auto">
                        {companies.map(company => (
                            <Box 
                                    key={company.id} 
                                    alignItems="center" 
                                    spacing="small" 
                                    padding="small"
                                    >
                                <Flex direction={'row'} gap={'md'} >
                                    <Checkbox
                                        checked={selectedCompanies.includes(Number(company.id))}
                                        onChange={() => handleCheckboxChange(Number(company.id))}
                                        label={company.properties.name}
                                        />
                                    {company.properties.name}
                                </Flex>
                            </Box>
                        ))}
                    </Box>
                    <Button
                        onClick={handleSave}
                        variant="primary"
                        disabled={isSaving}
                    >
                        {isSaving ? 'Saving...' : 'Save Associations'}
                    </Button>
                </>
            )}
        </Box>
    );
}
